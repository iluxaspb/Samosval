import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { applyFixtures, verifyFixtures } from '../scripts/isolated-db/fixtures.mjs';
import { transformLegacyMigrationGuard } from '../scripts/isolated-db/legacy-guards.mjs';
import { EXPECTED_S25_HASH, verifyS25Target, verifyTargetAuthority } from '../scripts/isolated-db/templates.mjs';

// The S25 provenance/archive contract can only be proven on a real S25 clone:
// two of the seven fixtures (the pre-025 legacy document behind the named v2
// bridge and the fixture registry itself) require table ownership, which a
// database child never receives — it runs as `samosval_test_app`. This root is
// therefore a harness contract, exactly like `isolated-db-fixtures.test.mjs`:
// it consumes the run's bootstrap-admin URL.
//
// When the selection also contains a database root, the real harness has
// already built and sealed the S25 template before any child starts, and this
// test clones exactly that artifact. When only harness contracts are selected
// (`needsTarget` is false), it builds the same S25 from the same sources so the
// contract is always proved by fact, never skipped.
const bootstrapUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
const OWNER = 'samosval_test_prepared_owner';
const S25_SEAL = `baseline=S25;version=25;registry=${EXPECTED_S25_HASH};owner=${OWNER}`;
const S25_FIXTURES = [
  'parallel-shift-legacy-unresolved',
  'parallel-shift-v2-night',
  'parallel-shift-cutover-report',
  'parallel-shift-restored-contexts',
  'archive-immutable-revisions',
  'restore-bootstrap-boundary',
  'parallel-shift-runtime-role',
];

function databaseUrl(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  url.search = '';
  url.hash = '';
  return url;
}

async function connect(base, database) {
  const client = new pg.Client({ connectionString: databaseUrl(base, database).href });
  await client.connect();
  return client;
}

function targetName() {
  return `samosval_parallel_shifts_test_${randomBytes(6).toString('hex')}_${randomBytes(6).toString('hex')}`;
}

// Rebuilds the exact S25 the harness builds: a fresh database receives
// migrations 001-025 and every public object is re-owned by the prepared owner,
// so the same authority verifier applies.
async function buildS25(admin) {
  const database = targetName();
  await admin.query(`CREATE DATABASE "${database}" OWNER ${OWNER}`);
  const pool = new pg.Pool({ connectionString: databaseUrl(bootstrapUrl, database).href, max: 1 });
  try {
    await applyMigrations(pool, {
      through: 25,
      transformSource: (sql, file) => transformLegacyMigrationGuard(sql, file, database),
    });
    await pool.query(`ALTER SCHEMA public OWNER TO ${OWNER}`);
    await pool.query(`DO $own$ DECLARE item record; BEGIN
      FOR item IN SELECT c.relkind,c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') LOOP
        EXECUTE format('ALTER TABLE public.%I OWNER TO ${OWNER}', item.relname);
      END LOOP;
    END $own$`);
    await pool.query(`DO $fn$ DECLARE item record; BEGIN
      FOR item IN SELECT p.proname, pg_get_function_identity_arguments(p.oid) args
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prokind='f' LOOP
        EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO ${OWNER}', item.proname, item.args);
      END LOOP;
    END $fn$`);
  } finally {
    await pool.end();
  }
  return database;
}

// The frozen template the harness built in this run, or a locally built S25.
async function s25Source(admin, created) {
  const sealed = (await admin.query(`SELECT d.datname, d.datallowconn, owner.rolname AS owner,
      description.description AS comment
    FROM pg_database d
    JOIN pg_roles owner ON owner.oid = d.datdba
    LEFT JOIN pg_shdescription description ON description.objoid = d.oid AND description.classoid = 'pg_catalog.pg_database'::regclass
    WHERE d.datname ~ '^samosval_parallel_shifts_test_[a-f0-9]{12,20}_tpl_s25$'`)).rows;
  assert.ok(sealed.length <= 1, 'at most one S25 template may exist for one run');
  if (sealed.length === 1) {
    const [template] = sealed;
    assert.equal(template.datallowconn, false, 'a frozen template accepts no connections');
    assert.equal(template.owner, OWNER);
    assert.ok(template.comment.endsWith(S25_SEAL), `sealed S25 comment must name the real registry: ${template.comment}`);
    return { database: template.datname, source: 'harness-template' };
  }
  const database = await buildS25(admin);
  created.push(database);
  return { database, source: 'rebuilt-from-sources' };
}

test('s25_provenance_fixtures_match_authority_contract', { skip: !bootstrapUrl }, async () => {
  const admin = new pg.Client({ connectionString: bootstrapUrl });
  await admin.connect();
  const created = [];
  try {
    const source = await s25Source(admin, created);

    // 1. One disposable clone is a real 025 schema, not a renamed S24: the
    //    verifier reads the registry checksums, key objects, migration function
    //    and enabled triggers from the clone itself.
    const target = targetName();
    await admin.query(`CREATE DATABASE "${target}" TEMPLATE "${source.database}" OWNER ${OWNER}`);
    created.push(target);
    const targetClient = await connect(bootstrapUrl, target);
    try {
      const verified = await verifyS25Target((text, values) => targetClient.query(text, values));
      assert.equal(verified.version, 25);
      assert.equal(verified.registryHash, EXPECTED_S25_HASH);
      await verifyTargetAuthority((text, values) => targetClient.query(text, values));

      // 2. Every S25 provenance/archive fixture applies and verifies on that
      //    clone; each report carries only true postconditions.
      const reports = await applyFixtures({ query: (text, values) => targetClient.query(text, values) }, [...S25_FIXTURES].reverse());
      assert.deepEqual(reports.map(report => report.id), S25_FIXTURES);
      for (const report of reports) {
        assert.equal(report.type, 'samosval-fixture-report:v1');
        assert.ok(Object.isFrozen(report));
        assert.deepEqual(Object.entries(report.postcondition).filter(([, value]) => value !== true), [], `${report.id} postcondition`);
        assert.ok(Object.keys(report.postcondition).length > 0, `${report.id} must prove at least one fact`);
      }
      // A second apply of the same fixture is refused, never silently repeated.
      await assert.rejects(
        applyFixtures({ query: (text, values) => targetClient.query(text, values) }, ['parallel-shift-v2-night']),
        /already applied|duplicate/i,
      );

      // 3. The verifier is a real check, not a rubber stamp: promoting the
      //    replica transport sender to the document creator must break it.
      await targetClient.query(`UPDATE replica_stream
        SET payload = jsonb_set(payload,'{senderUid}',to_jsonb(payload->'data'->>'startedByUid'))
        WHERE workspace_id=$1 AND operation_id=$2`, ['main_workspace', 'fixture_v2_night_operation']);
      await assert.rejects(
        verifyFixtures({ query: (text, values) => targetClient.query(text, values) }, ['parallel-shift-v2-night']),
        /postcondition failed: parallel-shift-v2-night/,
      );
    } finally {
      await targetClient.end();
    }

    // 4. The S25 source was never mutated by the fixtures: a fresh clone is a
    //    clean S25 with no fixture registry and no fixture rows.
    const clean = targetName();
    await admin.query(`CREATE DATABASE "${clean}" TEMPLATE "${source.database}" OWNER ${OWNER}`);
    created.push(clean);
    const cleanClient = await connect(bootstrapUrl, clean);
    try {
      await verifyS25Target((text, values) => cleanClient.query(text, values));
      const leftover = (await cleanClient.query(`SELECT
        to_regclass('public.samosval_fixture_registry') IS NULL AS no_registry,
        (SELECT count(*)::int FROM shifts) AS shifts,
        (SELECT count(*)::int FROM shift_archive_series) AS series`)).rows[0];
      assert.deepEqual(leftover, { no_registry: true, shifts: 0, series: 0 });
    } finally {
      await cleanClient.end();
    }
  } finally {
    for (const database of [...created].reverse()) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    }
    await admin.end();
  }
});
