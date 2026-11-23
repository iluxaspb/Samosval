import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { createTemplateBroker, generateRunCapability } from '../scripts/isolated-db/admin.mjs';
import { transformLegacyMigrationGuard } from '../scripts/isolated-db/legacy-guards.mjs';
import { EXPECTED_S24_HASH, EXPECTED_S24_REGISTRY, inspectTemplateSeal, prepareTemplates, verifyS24Target, verifyTargetAuthority } from '../scripts/isolated-db/templates.mjs';
import { GENERATED_DATABASE_PREFIX } from '../scripts/isolated-db/safety.mjs';

const runid = 'abcdef012345';
const emptyName = `${GENERATED_DATABASE_PREFIX}${runid}_tpl_empty`;
const s24Name = `${GENERATED_DATABASE_PREFIX}${runid}_tpl_s24`;
const migration = filename => readFileSync(new URL(`../sql/${filename}`, import.meta.url), 'utf8');
const OWNER = 'samosval_test_prepared_owner';
const sealedCatalogRow = comment => ({ owner: OWNER, super: false, createdb: false, createrole: false, canlogin: false, allow_connections: false, sessions: 0, memberships: 0, comment, datacl: `{${OWNER}=CTc/${OWNER},=T/${OWNER}}` });
const cleanAuthorityRow = { wrong_object_owners: 0, wrong_function_owners: 0, broad_object_acl: 0, broad_schema_acl: 0, default_acl_entries: 0 };

test('legacy guard exact checksum/count and separate helper compatibility', () => {
  const source = migration('002_tabel.sql');
  assert.match(transformLegacyMigrationGuard(source, '002_tabel.sql', s24Name), new RegExp(s24Name));
  assert.match(transformLegacyMigrationGuard(source, '002_tabel.sql', 'samosval_parallel_shifts_test', { legacyHelper: true, isolated: true }), /samosval_parallel_shifts_test/);
  assert.throws(() => transformLegacyMigrationGuard(source, '002_tabel.sql', 'samosval_parallel_shifts_test'), /identifier/i);
  assert.throws(() => transformLegacyMigrationGuard(source, '002_tabel.sql', 'samosval_test', { legacyHelper: true, isolated: true }), /helper target/i);
  assert.throws(() => transformLegacyMigrationGuard(source, '002_tabel.sql', 'samosval_parallel_shifts_test', { legacyHelper: true, isolated: false }), /helper target/i);
  assert.throws(() => transformLegacyMigrationGuard(`${source}\n--drift`, '002_tabel.sql', s24Name), /checksum/i);
  assert.throws(() => transformLegacyMigrationGuard("SELECT current_database()<>'x'", '025_parallel_shifts_core.sql', s24Name), /legacy guard unavailable/i);
});

test('trusted S24 verifier rejects missing, duplicate, extra, checksum, order and schema drift', async () => {
  const validSchema = { workspaces: true, users: true, authority: true, placeholder: true, replica: true, phones: true };
  const run = async (rows, schema = validSchema) => verifyS24Target(async sql => ({ rows: sql.includes('schema_migrations') ? rows : [schema] }));
  assert.equal((await run(EXPECTED_S24_REGISTRY.map(x => ({ ...x })))).registryHash, EXPECTED_S24_HASH);
  for (const rows of [
    EXPECTED_S24_REGISTRY.slice(1),
    [...EXPECTED_S24_REGISTRY, EXPECTED_S24_REGISTRY[0]],
    [...EXPECTED_S24_REGISTRY, { filename: '025_parallel_shifts_core.sql', checksum: 'a'.repeat(64) }],
    EXPECTED_S24_REGISTRY.map((x, i) => i ? x : { ...x, checksum: '0'.repeat(64) }),
    [...EXPECTED_S24_REGISTRY].reverse(),
  ]) await assert.rejects(run(rows), /registry verification/i);
  await assert.rejects(run(EXPECTED_S24_REGISTRY.map(x => ({ ...x })), { ...validSchema, replica: false }), /schema verification/i);
});

test('prepareTemplates consumes trusted queries, exact chain and complete authority inspection', async () => {
  const calls = [];
  const comments = new Map();
  const broker = createTemplateBroker({ bootstrapClient: { query: async sql => String(sql.text ?? sql).includes('pg_advisory_unlock') ? { rows: [{ unlocked: true }] } : { rows: [{ count: 0 }] }, end: async () => {} }, runid, capability: 'a'.repeat(64) });
  const context = {
    runid,
    templateOperation: async request => { calls.push(request.operation); const result = await broker.run({ ...request, capability: 'a'.repeat(64) }); if (result?.comment) comments.set(request.database, result.comment); return result; },
    async migrateTemplate() { calls.push('migrate'); },
    async queryTemplate(_db, sql) {
      return { rows: sql.includes('schema_migrations') ? EXPECTED_S24_REGISTRY.map(x => ({ ...x }))
        : sql.includes('pg_proc') ? [cleanAuthorityRow]
        : [{ workspaces: true, users: true, authority: true, replica: true, phones: true }] };
    },
    async queryCatalog(sql, values) {
      const database = values?.[1];
      if (!sql.includes('pg_shdescription')) return { rows: [] };
      return { rows: database === emptyName
        ? [sealedCatalogRow(`samosval-isolated-db:v1;kind=template;runid=${runid};baseline=empty;version=0;registry=empty;owner=${OWNER}`)]
        : [sealedCatalogRow(`samosval-isolated-db:v1;kind=template;runid=${runid};baseline=S24;version=24;registry=${EXPECTED_S24_HASH};owner=${OWNER}`)] };
    },
  };
  const records = await prepareTemplates(context);
  assert.deepEqual([...records.keys()], ['empty', 'S24']);
  assert.equal(records.get('S24').registryHash, EXPECTED_S24_HASH);
  assert.deepEqual(calls, ['createTemplate', 'freezeTemplate', 'createTemplate', 'migrate', 'freezeTemplate']);
});

test('seal rejects held session and every authority mutation', async () => {
  const broker = createTemplateBroker({ bootstrapClient: { query: async sql => String(sql.text ?? sql).includes('pg_stat_activity') ? { rows: [{ count: 1 }] } : { rows: [] }, end: async () => {} }, runid, capability: 'a'.repeat(64) });
  await assert.rejects(broker.run({ operation: 'freezeTemplate', database: emptyName, registryHash: 'empty', capability: 'a'.repeat(64) }), /failed closed/i);
  for (const key of Object.keys(cleanAuthorityRow)) {
    await assert.rejects(verifyTargetAuthority(async () => ({ rows: [{ ...cleanAuthorityRow, [key]: 1 }] })), /authority verification/i);
  }
  const sealed = sealedCatalogRow(`samosval-isolated-db:v1;kind=template;runid=${runid};baseline=empty;version=0;registry=empty;owner=${OWNER}`);
  for (const [key, value] of [
    ['super', true], ['createdb', true], ['createrole', true], ['canlogin', true],
    ['allow_connections', true], ['sessions', 1], ['memberships', 1],
    ['owner', 'samosval_test_bootstrap_admin'], ['comment', 'drift'],
    ['datacl', '{samosval_test_app=CTc/postgres}'], ['datacl', '{=c/postgres}'], ['datacl', ''],
  ]) {
    await assert.rejects(inspectTemplateSeal(async () => ({ rows: [{ ...sealed, [key]: value }] }), emptyName, sealed.comment), /template verification/i);
  }
  assert.deepEqual(await inspectTemplateSeal(async () => ({ rows: [sealed] }), emptyName, sealed.comment), { owner: OWNER, comment: sealed.comment, allowConnections: false, sessions: 0 });
  await assert.rejects(inspectTemplateSeal(async () => ({ rows: [] }), emptyName, sealed.comment), /template verification/i);
});

test('broker binds run/capability and derives exact semantic marker tuple', async () => {
  const capability = 'a'.repeat(64);
  const calls = [];
  const client = { query: async config => {
    calls.push(String(config.text ?? config));
    if (String(config.text ?? config).includes('pg_stat_activity')) return { rows: [{ count: 0 }] };
    if (String(config.text ?? config).includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    return { rows: [] };
  }, end: async () => {} };
  const broker = createTemplateBroker({ bootstrapClient: client, runid, capability });
  const empty = await broker.run({ operation: 'freezeTemplate', database: emptyName, registryHash: 'empty', capability });
  assert.match(empty.comment, /baseline=empty;version=0;registry=empty/);
  const s24 = await broker.run({ operation: 'freezeTemplate', database: s24Name, registryHash: EXPECTED_S24_HASH, capability });
  assert.match(s24.comment, new RegExp(`baseline=S24;version=24;registry=${EXPECTED_S24_HASH}`));
  for (const request of [
    { operation: 'freezeTemplate', database: s24Name, registryHash: 'empty', capability },
    { operation: 'freezeTemplate', database: s24Name, registryHash: 'b'.repeat(64), capability },
    { operation: 'freezeTemplate', database: s24Name, registryHash: EXPECTED_S24_HASH, capability, runid: 'ffffffffffff' },
    { operation: 'freezeTemplate', database: s24Name, registryHash: EXPECTED_S24_HASH, capability: 'c'.repeat(64) },
    { operation: 'freezeTemplate', database: s24Name, registryHash: EXPECTED_S24_HASH },
    { operation: 'sql', sql: 'DROP DATABASE postgres', capability },
  ]) await assert.rejects(broker.run(request), /not approved/i);
});

const bootstrapUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
const appPassword = process.env.SAMOSVAL_TEST_APP_PASSWORD;

test('real PostgreSQL helper, immutable S24 and usable clone', { skip: !bootstrapUrl || !appPassword }, async () => {
  const realRun = 'abcdeffedcba';
  const capability = generateRunCapability();
  const admin = new pg.Client({ connectionString: bootstrapUrl });
  await admin.connect();
  const broker = createTemplateBroker({ bootstrapClient: admin, runid: realRun, capability });
  const empty = `${GENERATED_DATABASE_PREFIX}${realRun}_tpl_empty`;
  const s24 = `${GENERATED_DATABASE_PREFIX}${realRun}_tpl_s24`;
  const clone = `${GENERATED_DATABASE_PREFIX}${realRun}_cccccccccccc`;
  try {
    await broker.run({ operation: 'createTemplate', database: empty, source: 'template0', capability });
    await broker.run({ operation: 'freezeTemplate', database: empty, registryHash: 'empty', capability });
    await broker.run({ operation: 'createTemplate', database: s24, source: empty, capability });
    const url = new URL(bootstrapUrl);
    url.pathname = `/${s24}`;
    const pool = new pg.Pool({ connectionString: url.href, max: 1 });
    await applyMigrations(pool, { through: 24, transformSource: (src, file) => transformLegacyMigrationGuard(src, file, s24) });
    await pool.query(`ALTER SCHEMA public OWNER TO ${OWNER}`);
    await pool.query(`DO $own$ DECLARE item record; BEGIN FOR item IN SELECT c.relkind,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') LOOP EXECUTE format(CASE WHEN item.relkind='S' THEN 'ALTER SEQUENCE public.%I OWNER TO ${OWNER}' ELSE 'ALTER TABLE public.%I OWNER TO ${OWNER}' END,item.relname); END LOOP; END $own$`);
    await pool.query(`DO $fn$ DECLARE item record; BEGIN FOR item IN SELECT p.proname, pg_get_function_identity_arguments(p.oid) args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' LOOP EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO ${OWNER}', item.proname, item.args); END LOOP; END $fn$`);
    await pool.end();
    await verifyS24Target(async (text, values) => { const c = await fresh(url); try { return await c.query(text, values); } finally { await c.end(); } });
    await verifyTargetAuthority(async (text, values) => { const c = await fresh(url); try { return await c.query(text, values); } finally { await c.end(); } });
    await broker.run({ operation: 'freezeTemplate', database: s24, registryHash: EXPECTED_S24_HASH, capability });
    await admin.query(`CREATE DATABASE "${clone}" TEMPLATE "${s24}" OWNER ${OWNER}`);
    await admin.query(`GRANT CONNECT ON DATABASE "${clone}" TO samosval_test_app`);
    const cloneUrl = new URL(cloneDbUrl(bootstrapUrl, clone));
    const owner = new pg.Client({ connectionString: cloneUrl.href });
    await owner.connect();
    await owner.query(`GRANT USAGE ON SCHEMA public TO samosval_test_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO samosval_test_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO samosval_test_app`);
    await owner.end();
    cloneUrl.username = 'samosval_test_app';
    cloneUrl.password = appPassword;
    const app = new pg.Client({ connectionString: cloneUrl.href });
    await app.connect();
    try {
      assert.equal((await app.query('SELECT count(*)::int n FROM workspaces')).rows[0].n, 1);
      await app.query(`INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES ('main_workspace','probe','{}')`);
      await assert.rejects(app.query(`ALTER DATABASE "${s24}" ALLOW_CONNECTIONS true`), /owner|permission/i);
      await assert.rejects(app.query(`CREATE SCHEMA forbidden`), /permission/i);
    } finally { await app.end(); }
  } finally {
    for (const db of [clone, s24, empty]) await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});

async function fresh(url) { const c = new pg.Client({ connectionString: url.href }); await c.connect(); return c; }
function cloneDbUrl(base, name) { const u = new URL(base); u.pathname = `/${name}`; return u; }

test('legacy helper migration regression on approved isolated helper DB', { skip: !bootstrapUrl || !appPassword }, async () => {
  const helper = 'samosval_parallel_shifts_test';
  const admin = new pg.Client({ connectionString: bootstrapUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${helper}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${helper}" TEMPLATE template0 OWNER ${OWNER}`);
    const helperUrl = new URL(bootstrapUrl);
    helperUrl.pathname = `/${helper}`;
    const pool = new pg.Pool({ connectionString: helperUrl.href, max: 1 });
    await applyMigrations(pool, { through: 24, transformSource: (src, file) => transformLegacyMigrationGuard(src, file, helper, { legacyHelper: true, isolated: true }) });
    await pool.end();
    const probe = new pg.Client({ connectionString: helperUrl.href });
    await probe.connect();
    try {
      const registry = await verifyS24Target((text, values) => probe.query(text, values));
      assert.equal(registry.version, 24);
      assert.equal((await probe.query(`SELECT count(*)::int n FROM schema_migrations`)).rows[0].n, registry.count);
    } finally { await probe.end(); }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${helper}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});
