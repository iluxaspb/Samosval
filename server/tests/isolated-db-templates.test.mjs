import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { createTemplateBroker, generateRunCapability } from '../scripts/isolated-db/admin.mjs';
import { transformLegacyMigrationGuard } from '../scripts/isolated-db/legacy-guards.mjs';
import { prepareTemplates } from '../scripts/isolated-db/templates.mjs';
import { GENERATED_DATABASE_PREFIX } from '../scripts/isolated-db/safety.mjs';

const runid = 'abcdef012345';
const emptyName = `${GENERATED_DATABASE_PREFIX}${runid}_tpl_empty`;
const s24Name = `${GENERATED_DATABASE_PREFIX}${runid}_tpl_s24`;

function migration(filename) {
  return readFileSync(new URL(`../sql/${filename}`, import.meta.url), 'utf8');
}

test('legacy guard transform requires exact migration checksum and occurrence count', () => {
  const source = migration('002_tabel.sql');
  const transformed = transformLegacyMigrationGuard(source, '002_tabel.sql', s24Name);
  assert.match(transformed, new RegExp(`current_database\\(\\) <> '${s24Name}'`));
  assert.doesNotMatch(transformed, /current_database\(\) <> 'samosval_test'/);
  assert.throws(() => transformLegacyMigrationGuard(`${source}\n-- drift`, '002_tabel.sql', s24Name), /legacy migration checksum mismatch/i);
  assert.throws(() => transformLegacyMigrationGuard(source.replace("current_database() <> 'samosval_test'", 'current_database() IS NULL'), '002_tabel.sql', s24Name), /legacy migration checksum mismatch/i);
  assert.throws(() => transformLegacyMigrationGuard(source, '025_parallel_shifts_core.sql', s24Name), /legacy guard unavailable/i);
});

test('prepareTemplates creates exact template0 to empty to S24 chain and freezes both templates', async () => {
  const calls = [];
  const context = {
    runid,
    capability: 'a'.repeat(64),
    async templateOperation(request) { calls.push(request); },
    async migrateTemplate(request) { calls.push({ operation: 'migrate', ...request }); return { count: 22, version: 24, registryHash: 'b'.repeat(64) }; },
    async inspectTemplate(request) { calls.push({ operation: 'inspect', ...request }); return { owner: 'samosval_test_prepared_owner', comment: request.comment, allowConnections: false, sessions: 0 }; },
  };
  const records = await prepareTemplates(context);
  assert.deepEqual([...records.keys()], ['empty', 'S24']);
  assert.equal(records.get('empty').database, emptyName);
  assert.equal(records.get('empty').source, 'template0');
  assert.equal(records.get('S24').database, s24Name);
  assert.equal(records.get('S24').source, emptyName);
  assert.equal(records.get('S24').version, 24);
  assert.ok(Object.isFrozen(records.get('empty')) && Object.isFrozen(records.get('S24')));
  assert.deepEqual(calls.map(call => call.operation), [
    'createTemplate', 'freezeTemplate', 'inspect',
    'createTemplate', 'migrate', 'freezeTemplate', 'inspect',
  ]);
  for (const request of calls.filter(call => call.operation === 'createTemplate')) {
    assert.equal(Object.hasOwn(request, 'adminUrl'), false);
    assert.equal(Object.hasOwn(request, 'sql'), false);
  }
});

test('template inspection rejects mutable authority, active sessions and marker drift', async () => {
  const base = {
    runid,
    capability: 'a'.repeat(64),
    async templateOperation() {},
    async migrateTemplate() { return { count: 22, version: 24, registryHash: 'b'.repeat(64) }; },
  };
  for (const inspection of [
    { owner: 'samosval_test_app', allowConnections: false, sessions: 0 },
    { owner: 'samosval_test_prepared_owner', allowConnections: true, sessions: 0 },
    { owner: 'samosval_test_prepared_owner', allowConnections: false, sessions: 1 },
    { owner: 'samosval_test_prepared_owner', allowConnections: false, sessions: 0, comment: 'wrong' },
  ]) {
    await assert.rejects(prepareTemplates({ ...base, async inspectTemplate() { return inspection; } }), /template verification failed closed/i);
  }
});

test('template preparation exposes no S25 or S26 baseline', async () => {
  const records = await prepareTemplates({
    runid,
    capability: 'a'.repeat(64),
    async templateOperation() {},
    async migrateTemplate() { return { count: 22, version: 24, registryHash: 'b'.repeat(64) }; },
    async inspectTemplate({ comment }) { return { owner: 'samosval_test_prepared_owner', comment, allowConnections: false, sessions: 0 }; },
  });
  assert.equal(records.has('S25'), false);
  assert.equal(records.has('S26'), false);
});

const bootstrapUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
const appPassword = process.env.SAMOSVAL_TEST_APP_PASSWORD;

test('real PostgreSQL builds immutable empty/S24 templates with exact legacy registry', { skip: !bootstrapUrl || !appPassword }, async () => {
  const realRunid = 'abcdeffedcba';
  const capability = generateRunCapability();
  const bootstrap = new pg.Client({ connectionString: bootstrapUrl });
  await bootstrap.connect();
  const broker = createTemplateBroker({ bootstrapClient: bootstrap });
  const created = [];
  const context = {
    runid: realRunid,
    capability,
    templateOperation: request => broker.run(request).then(() => created.push(request.database)),
    async migrateTemplate({ database }) {
      const url = new URL(bootstrapUrl); url.pathname = `/${database}`; url.username = 'samosval_test_bootstrap_admin';
      const pool = new pg.Pool({ connectionString: url.href, max: 1 });
      try {
        await applyMigrations(pool, { through: 24, transformSource: (source, filename) => transformLegacyMigrationGuard(source, filename, database) });
        await pool.query('ALTER SCHEMA public OWNER TO samosval_test_prepared_owner');
        const rows = (await pool.query("SELECT filename,checksum FROM schema_migrations WHERE filename ~ '^[0-9]{3}_' ORDER BY filename")).rows;
        return { count: rows.length, version: Number(rows.at(-1).filename.slice(0, 3)), registryHash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
      } finally { await pool.end(); }
    },
    async inspectTemplate({ database }) {
      const row = (await bootstrap.query(`SELECT role.rolname AS owner, description.description AS comment, d.datallowconn AS "allowConnections", (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname=d.datname) AS sessions FROM pg_database d JOIN pg_roles role ON role.oid=d.datdba LEFT JOIN pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_database'::regclass WHERE d.datname=$1`, [database])).rows[0];
      return row;
    },
  };
  try {
    const records = await prepareTemplates(context);
    assert.deepEqual([...records.keys()], ['empty', 'S24']);
    const s24 = records.get('S24');
    const clone = `${GENERATED_DATABASE_PREFIX}${realRunid}_cccccccccccc`;
    await bootstrap.query(`CREATE DATABASE "${clone}" TEMPLATE "${s24.database}" OWNER samosval_test_prepared_owner`);
    try {
      const cloneUrl = new URL(bootstrapUrl); cloneUrl.pathname = `/${clone}`;
      const cloneAdmin = new pg.Client({ connectionString: cloneUrl.href }); await cloneAdmin.connect();
      try { assert.equal((await cloneAdmin.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, 22); }
      finally { await cloneAdmin.end(); }
      const appUrl = new URL(bootstrapUrl); appUrl.pathname = `/${clone}`; appUrl.username = 'samosval_test_app'; appUrl.password = appPassword;
      await bootstrap.query(`GRANT CONNECT ON DATABASE "${clone}" TO samosval_test_app`);
      const app = new pg.Client({ connectionString: appUrl.href }); await app.connect();
      try { await assert.rejects(app.query(`ALTER DATABASE "${s24.database}" ALLOW_CONNECTIONS true`), /must be owner|permission denied/i); }
      finally { await app.end(); }
      assert.equal((await bootstrap.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=ANY($1)', [[records.get('empty').database, s24.database]])).rows[0].count, 0);
    } finally { await bootstrap.query(`DROP DATABASE IF EXISTS "${clone}" WITH (FORCE)`); }
  } finally {
    for (const database of [...new Set(created)].reverse()) await bootstrap.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await bootstrap.end();
  }
});
