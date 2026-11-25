import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createProvisioningBroker, generateRunCapability } from '../scripts/isolated-db/admin.mjs';
import { GENERATED_DATABASE_PREFIX } from '../scripts/isolated-db/safety.mjs';
import { bootstrapParallelShiftRoles, verifyParallelShiftRoleBoundary } from '../scripts/parallel-shifts-role-bootstrap.mjs';

const { Client } = pg;
const bootstrapUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
const runtimePassword = process.env.SAMOSVAL_TEST_RUNTIME_PASSWORD;
const maintenancePassword = process.env.SAMOSVAL_TEST_MAINTENANCE_PASSWORD;
function urlFor(database, role, password) { const url = new URL(bootstrapUrl); url.pathname = `/${database}`; url.username = role; url.password = password; return url.href; }
async function withClient(url, fn) { const client = new Client({ connectionString: url }); await client.connect(); try { return await fn(client); } finally { await client.end(); } }
async function rejectsQuery(client, sql, re = /permission denied|does not exist|must be owner|not have permission/i) { await assert.rejects(client.query(sql), re); }

test('parallel shift runtime and maintenance role boundary is isolated and idempotent', { skip: !bootstrapUrl || !runtimePassword || !maintenancePassword }, async () => {
  const bootstrapClient = new Client({ connectionString: bootstrapUrl }); await bootstrapClient.connect();
  const runid = randomBytes(6).toString('hex');
  const capability = generateRunCapability();
  const database = `${GENERATED_DATABASE_PREFIX}${runid}_${createHash('sha256').update('parallel-shifts-runtime-roles').digest('hex').slice(0, 12)}`;
  const broker = createProvisioningBroker({ bootstrapClient }); let created = false;
  try {
    await broker.run({ operation: 'createReservedTarget', database, runid, capability }); created = true;
    await withClient(urlFor(database, 'samosval_test_bootstrap_admin', new URL(bootstrapUrl).password), async client => {
      await client.query('CREATE TABLE public.role_probe_table(id integer)');
      await client.query('CREATE FUNCTION public.role_probe_migration() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::void $$');
      const opts = { runtimePassword, maintenancePassword, database, objects: { tables: ['role_probe_table'], functions: ['role_probe_migration()'] } };
      await bootstrapParallelShiftRoles(client, opts); await bootstrapParallelShiftRoles(client, opts);
      await client.query('ALTER ROLE samosval_runtime BYPASSRLS');
      await bootstrapParallelShiftRoles(client, opts);
      const report = await verifyParallelShiftRoleBoundary(client, opts.objects);
      assert.equal(JSON.stringify(report).includes(runtimePassword), false); assert.equal(JSON.stringify(report).includes(maintenancePassword), false);
      assert.deepEqual(report.roles.runtime, { superuser: false, bypassrls: false, canlogin: true, memberOf: [] });
      assert.deepEqual(report.roles.maintenance.memberOf, []);
      assert.deepEqual(report.owners.runtimeOwnedObjects, []); assert.deepEqual(report.owners.maintenanceOwnedObjects, []);
    });
    await withClient(urlFor(database, 'samosval_runtime', runtimePassword), async client => {
      const role = (await client.query('SELECT rolsuper AS superuser, rolbypassrls AS bypassrls, NOT rolcanlogin AS no_login FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.deepEqual(role, { superuser: false, bypassrls: false, no_login: false });
      assert.equal((await client.query('SELECT 1')).rows[0]['?column?'], 1);
      assert.equal((await client.query('SELECT * FROM public.role_probe_table')).rowCount, 0);
      await rejectsQuery(client, 'SET ROLE samosval_schema_owner');
      for (const sql of ['INSERT INTO public.role_probe_table VALUES (1)', 'UPDATE public.role_probe_table SET id=2', 'DELETE FROM public.role_probe_table', 'ALTER TABLE public.role_probe_table ADD COLUMN denied integer', 'CREATE TRIGGER denied_trigger AFTER INSERT ON public.role_probe_table FOR EACH ROW EXECUTE FUNCTION public.role_probe_migration()', 'CREATE OR REPLACE FUNCTION public.role_probe_migration() RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$', 'SELECT public.role_probe_migration()']) await rejectsQuery(client, sql);
    });
    await withClient(urlFor(database, 'samosval_maintenance', maintenancePassword), async client => {
      await rejectsQuery(client, 'SELECT public.role_probe_migration()');
      await withClient(urlFor(database, 'samosval_test_bootstrap_admin', new URL(bootstrapUrl).password), admin => admin.query('GRANT EXECUTE ON FUNCTION public.role_probe_migration() TO samosval_maintenance'));
      assert.equal((await client.query("SELECT has_function_privilege(current_user, 'public.role_probe_migration()', 'EXECUTE') AS allowed")).rows[0].allowed, true);
      await withClient(urlFor(database, 'samosval_test_bootstrap_admin', new URL(bootstrapUrl).password), admin => admin.query('REVOKE EXECUTE ON FUNCTION public.role_probe_migration() FROM samosval_maintenance'));
      await rejectsQuery(client, 'SELECT public.role_probe_migration()');
    });
  } finally {
    if (created) await broker.run({ operation: 'dropReservedTarget', database, runid, capability }).catch(() => {});
    await bootstrapClient.end();
  }
});
