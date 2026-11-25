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
       await client.query('CREATE TABLE public.shifts(id integer)');
       await client.query('CREATE TABLE public.shift_members(id integer)');
       await client.query('CREATE TABLE public.line_truck_statuses(id integer)');
       await client.query('CREATE TABLE public.line_logs(id integer)');
       await client.query('CREATE FUNCTION public.shifts_legacy_bridge() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::void $$');
       await client.query('CREATE FUNCTION public.enforce_shift_member_role() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::void $$');
       const opts = { runtimePassword, maintenancePassword, database, objects: { tables: ['shifts', 'shift_members', 'line_truck_statuses'], functions: ['shifts_legacy_bridge()', 'enforce_shift_member_role()'] } };
       await assert.rejects(bootstrapParallelShiftRoles(client, { ...opts, objects: { tables: ['app_users'] } }), /not an approved parallel-shift object/);
      await bootstrapParallelShiftRoles(client, opts); await bootstrapParallelShiftRoles(client, opts);
      await client.query('ALTER ROLE samosval_runtime BYPASSRLS');
      await bootstrapParallelShiftRoles(client, opts);
       const report = await verifyParallelShiftRoleBoundary(client, opts.objects);
       assert.equal(JSON.stringify(report).includes(runtimePassword), false); assert.equal(JSON.stringify(report).includes(maintenancePassword), false);
       assert.deepEqual(report.roles.runtime, { superuser: false, bypassrls: false, canlogin: true, memberOf: [] });
       assert.deepEqual(report.roles.maintenance.memberOf, []);
       assert.deepEqual(report.owners.runtimeOwnedObjects, []); assert.deepEqual(report.owners.maintenanceOwnedObjects, []);
       assert.deepEqual(report.functionExecute, {
         'shifts_legacy_bridge()': { public: false, runtime: false, maintenance: false },
         'enforce_shift_member_role()': { public: false, runtime: false, maintenance: false },
       });
       assert.deepEqual(report.violations, []);
       await client.query('GRANT EXECUTE ON FUNCTION public.shifts_legacy_bridge() TO samosval_runtime');
       await client.query('GRANT INSERT ON TABLE public.shifts TO samosval_runtime');
       await bootstrapParallelShiftRoles(client, opts);
       const recovered = await verifyParallelShiftRoleBoundary(client, opts.objects);
       assert.equal(recovered.functionExecute['shifts_legacy_bridge()'].runtime, false);
       assert.equal((await client.query("SELECT has_table_privilege('samosval_runtime', 'public.shifts', 'INSERT') AS allowed")).rows[0].allowed, false);
       assert.equal((await client.query("SELECT has_table_privilege('samosval_runtime', 'public.line_logs', 'INSERT') AS allowed")).rows[0].allowed, false);
    });
    await withClient(urlFor(database, 'samosval_runtime', runtimePassword), async client => {
      const role = (await client.query('SELECT rolsuper AS superuser, rolbypassrls AS bypassrls, NOT rolcanlogin AS no_login FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.deepEqual(role, { superuser: false, bypassrls: false, no_login: false });
      assert.equal((await client.query('SELECT 1')).rows[0]['?column?'], 1);
       assert.equal((await client.query('SELECT * FROM public.shifts')).rowCount, 0);
      await rejectsQuery(client, 'SET ROLE samosval_schema_owner');
       for (const sql of ['INSERT INTO public.shifts VALUES (1)', 'UPDATE public.shifts SET id=2', 'DELETE FROM public.shifts', 'ALTER TABLE public.shifts ADD COLUMN denied integer', 'CREATE TRIGGER denied_trigger AFTER INSERT ON public.shifts FOR EACH ROW EXECUTE FUNCTION public.shifts_legacy_bridge()', 'CREATE OR REPLACE FUNCTION public.shifts_legacy_bridge() RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$', 'SELECT public.shifts_legacy_bridge()']) await rejectsQuery(client, sql);
    });
    await withClient(urlFor(database, 'samosval_maintenance', maintenancePassword), async client => {
       await rejectsQuery(client, 'SELECT public.shifts_legacy_bridge()');
       await withClient(urlFor(database, 'samosval_test_bootstrap_admin', new URL(bootstrapUrl).password), admin => admin.query('GRANT EXECUTE ON FUNCTION public.shifts_legacy_bridge() TO samosval_maintenance'));
       assert.equal((await client.query("SELECT has_function_privilege(current_user, 'public.shifts_legacy_bridge()', 'EXECUTE') AS allowed")).rows[0].allowed, true);
       await withClient(urlFor(database, 'samosval_test_bootstrap_admin', new URL(bootstrapUrl).password), admin => admin.query('REVOKE EXECUTE ON FUNCTION public.shifts_legacy_bridge() FROM samosval_maintenance'));
       await rejectsQuery(client, 'SELECT public.shifts_legacy_bridge()');
    });
  } finally {
    if (created) await broker.run({ operation: 'dropReservedTarget', database, runid, capability }).catch(() => {});
    await bootstrapClient.end();
  }
});
