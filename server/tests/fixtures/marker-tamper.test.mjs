import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { GENERATED_DATABASE_PREFIX } from '../../scripts/isolated-db/safety.mjs';

// Harness fixture: a deliberately tampered target marker must end as a
// reported leak, never as a silent drop, and the run itself stays green
// (a tamper is expected behaviour for the leak check, not a suite failure).
// Inert without the exact harness marker contract, like the other fixtures.

const bootstrapUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
const appPassword = process.env.SAMOSVAL_TEST_APP_PASSWORD;
const runtimePassword = process.env.SAMOSVAL_TEST_RUNTIME_PASSWORD;
const armed = process.env.SAMOSVAL_TAMPER_FIXTURE === '1' && bootstrapUrl && appPassword && runtimePassword;

test('marker tamper fixture is inert without its explicit harness marker', { skip: armed }, () => {});

test('deliberate marker tamper is reported as a leak and no destructive query runs', { skip: !armed }, async () => {
  const { makeRunIdentity, makeTargetName, cleanupTarget, leakCheck, TARGET_OWNER, provisionTarget } =
    await import('../../scripts/isolated-db/database.mjs');
  const { createTemplateBroker } = await import('../../scripts/isolated-db/admin.mjs');
  const { prepareTemplates } = await import('../../scripts/isolated-db/templates.mjs');
  const { applyMigrations } = await import('../../scripts/apply-migrations.mjs');
  const { transformLegacyMigrationGuard } = await import('../../scripts/isolated-db/legacy-guards.mjs');

  const identity = makeRunIdentity();
  const admin = new pg.Client({ connectionString: bootstrapUrl });
  await admin.connect();
  const urlFor = database => { const u = new URL(bootstrapUrl); u.pathname = `/${database}`; return u.href; };
  try {
    const templateBroker = createTemplateBroker({ bootstrapClient: admin, runid: identity.runid, capability: identity.capability });
    const templates = await prepareTemplates({
      runid: identity.runid,
      templateOperation: request => templateBroker.run({ ...request, capability: identity.capability }),
      async migrateTemplate({ database, through }) {
        const pool = new pg.Pool({ connectionString: urlFor(database), max: 1 });
        try {
          await applyMigrations(pool, { through, transformSource: (source, file) => transformLegacyMigrationGuard(source, file, database) });
          await pool.query(`ALTER SCHEMA public OWNER TO ${TARGET_OWNER}`);
          await pool.query(`DO $own$ DECLARE item record; BEGIN FOR item IN SELECT c.relkind,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') LOOP EXECUTE format(CASE WHEN item.relkind='S' THEN 'ALTER SEQUENCE public.%I OWNER TO ${TARGET_OWNER}' ELSE 'ALTER TABLE public.%I OWNER TO ${TARGET_OWNER}' END,item.relname); END LOOP; END $own$`);
          await pool.query(`DO $fn$ DECLARE item record; BEGIN FOR item IN SELECT p.proname, pg_get_function_identity_arguments(p.oid) args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' LOOP EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO ${TARGET_OWNER}', item.proname, item.args); END LOOP; END $fn$`);
        } finally { await pool.end(); }
      },
      async queryTemplate(database, text, values) { const c = new pg.Client({ connectionString: urlFor(database) }); try { await c.connect(); return await c.query(text, values); } finally { await c.end(); } },
      async queryCatalog(text, values) { return admin.query(text, values); },
    });
    const context = { bootstrapClient: admin, runid: identity.runid, capability: identity.capability, templates };
    const record = await provisionTarget(context, { file: 'tests/marker-tamper-fixture-file.test.mjs', baseline: 'S24' });
    const session = new pg.Client({ connectionString: urlFor(record.database) });
    await session.connect();
    try {
      assert.equal((await session.query('SELECT 1 AS alive')).rows[0].alive, 1);
      await admin.query(`COMMENT ON DATABASE "${record.database}" IS 'marker tampered by harness'`);
      await assert.rejects(cleanupTarget(context, record.transition('running'), { phase: 'assertion' }), error => error.code === 'ESAFETY');
      assert.equal((await session.query('SELECT 1 AS alive')).rows[0].alive, 1, 'a tampered target must not be terminated');
      const leak = await leakCheck(context, { tracked: [record] });
      assert.equal(leak.clean, false);
      assert.deepEqual(leak.leaks.filter(leak => leak.database === record.database), [{ database: record.database, reason: 'identity' }]);
    } finally {
      // Test-side privileged teardown of the deliberately tampered object.
      await session.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${record.database}" WITH (FORCE)`).catch(() => {});
    }
  } finally {
    for (const row of (await admin.query('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [`${GENERATED_DATABASE_PREFIX}${identity.runid}_`])).rows) await admin.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`).catch(() => {});
    await admin.query('DELETE FROM samosval_isolated_admin.target_receipts WHERE runid=$1', [identity.runid]).catch(() => {});
    await admin.end();
  }
});
