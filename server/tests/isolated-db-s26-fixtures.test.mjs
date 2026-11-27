import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { applyFixtures } from '../scripts/isolated-db/fixtures.mjs';
import { transformLegacyMigrationGuard } from '../scripts/isolated-db/legacy-guards.mjs';
import { EXPECTED_S26_HASH, EXPECTED_S26_REGISTRY, verifyS25Target, verifyS26Target, verifyTargetAuthority } from '../scripts/isolated-db/templates.mjs';

const bootstrapUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
const OWNER = 'samosval_test_prepared_owner';
const PREFIX = 'samosval_parallel_shifts_test_';
const targetName = () => `${PREFIX}${randomBytes(6).toString('hex')}_${randomBytes(6).toString('hex')}`;
const dbUrl = (base, database) => { const url = new URL(base); url.pathname = `/${database}`; url.search = ''; url.hash = ''; return url; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ownSchema(pool) {
  await pool.query(`ALTER SCHEMA public OWNER TO ${OWNER}`);
  await pool.query(`DO $own$ DECLARE item record; BEGIN FOR item IN SELECT c.relkind,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') LOOP EXECUTE format(CASE WHEN item.relkind='S' THEN 'ALTER SEQUENCE public.%I OWNER TO ${OWNER}' ELSE 'ALTER TABLE public.%I OWNER TO ${OWNER}' END,item.relname); END LOOP; END $own$`);
  await pool.query(`DO $fn$ DECLARE item record; BEGIN FOR item IN SELECT p.proname,pg_get_function_identity_arguments(p.oid) args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' LOOP EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO ${OWNER}',item.proname,item.args); END LOOP; END $fn$`);
}

// A pooled client that receives a backend shutdown (57P01 and friends) emits an
// 'error' event; without a listener Node turns it into an uncaughtException and
// the whole file fails for a reason that has nothing to do with the contract
// under test. The error is collected instead, and the run asserts that nothing
// unexpected was collected — so a real connection loss still fails loudly
// (`docs/opyt-oshibok.md` lesson 49).
function openPool(database, losses) {
  const pool = new pg.Pool({ connectionString: dbUrl(bootstrapUrl, database).href, max: 1 });
  pool.on('error', error => losses.push(error));
  return pool;
}

// `CREATE DATABASE ... TEMPLATE` refuses a source that still has sessions, and a
// FORCE drop that terminates a half-closed backend is the classic source of a
// spurious 57P01. Both are avoided by waiting until the server really has no
// backend on the database, exactly as `migration-registry.test.mjs` does.
async function quiesce(admin, database) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database]);
    if (rows[0].n === 0) return;
    await sleep(50);
  }
  throw new Error(`database ${database} still has sessions before the next step`);
}

// Builds the exact S25 the harness builds: a fresh database receives migrations
// 001-025 and every public object is re-owned by the prepared owner, so the same
// authority verifier applies. A fresh build is deliberate: the root must prove
// the contract on artifacts it created itself, never on a foreign template that
// merely carries a matching comment.
async function createS25(admin, cleanup, losses) {
  const name = targetName(); cleanup.push(name);
  await admin.query(`CREATE DATABASE "${name}" OWNER ${OWNER}`);
  const pool = openPool(name, losses);
  try {
    await applyMigrations(pool, { through: 25, transformSource: (sql, file) => transformLegacyMigrationGuard(sql, file, name) });
    await ownSchema(pool);
    await verifyS25Target((sql, values) => pool.query(sql, values));
    await verifyTargetAuthority((sql, values) => pool.query(sql, values));
  } finally { await pool.end(); }
  await quiesce(admin, name);
  return name;
}

test('s26_replica_restore_fixtures_match_026_authority_contract', { skip: !bootstrapUrl }, async () => {
  const admin = new pg.Client({ connectionString: bootstrapUrl });
  await admin.connect();
  const cleanup = [];
  const losses = [];
  try {
    const s25 = await createS25(admin, cleanup, losses);
    const s26 = targetName(); cleanup.push(s26);
    await admin.query(`CREATE DATABASE "${s26}" TEMPLATE "${s25}" OWNER ${OWNER}`);
    const pool = openPool(s26, losses);
    try {
      await applyMigrations(pool, { through: 26 });
      await ownSchema(pool);
      const result = await verifyS26Target((sql, values) => pool.query(sql, values));
      assert.deepEqual(result, { count: EXPECTED_S26_REGISTRY.length, version: 26, registryHash: EXPECTED_S26_HASH });
      assert.deepEqual(EXPECTED_S26_REGISTRY.slice(-1).map(item => item.filename), ['026_parallel_shift_dependencies.sql']);
      await verifyTargetAuthority((sql, values) => pool.query(sql, values));
      const fixtureReports = await applyFixtures({ query: (sql, values) => pool.query(sql, values) }, ['replica-pending-empty']);
      assert.deepEqual(fixtureReports.map(report => report.id), ['replica-pending-empty']);
      assert.deepEqual(fixtureReports[0].postcondition, { empty: true, noPayload: true, triggers: true });

      const outOfOrderReports = await applyFixtures({ query: (sql, values) => pool.query(sql, values) }, ['replica-pending-out-of-order']);
      assert.deepEqual(outOfOrderReports.map(report => report.id), ['replica-pending-out-of-order']);
      assert.deepEqual(outOfOrderReports[0].postcondition, {
        streamOperations: 4,
        settledHeads: 2,
        pendingDocuments: 1,
        pendingPayloadColumns: 0,
        parentAbsent: true,
      });

      const fullRestoreReport = await applyFixtures({ query: (sql, values) => pool.query(sql, values) }, ['full-exact-provenance-restore']);
      assert.deepEqual(fullRestoreReport.map(report => report.id), ['full-exact-provenance-restore']);
      assert.deepEqual(fullRestoreReport[0].postcondition, {
        collections: 6,
        exactProvenance: true,
        tombstones: 2,
        pendingDocuments: 0,
      });
    } finally { await pool.end(); }
    assert.deepEqual(losses.map(error => error.code), [], 'no pooled client may lose its backend during the contract run');
  } finally {
    for (const database of cleanup.reverse()) {
      await quiesce(admin, database).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    }
    const leaked = (await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [cleanup])).rows.map(row => row.datname);
    await admin.end();
    assert.deepEqual(leaked, [], 'the root must not leave its scratch databases behind');
  }
});
