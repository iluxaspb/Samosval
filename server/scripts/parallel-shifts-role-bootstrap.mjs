#!/usr/bin/env node
import pg from 'pg';

const { Client } = pg;
const ROLE_NAMES = ['samosval_schema_owner', 'samosval_migration_evidence_owner', 'samosval_runtime', 'samosval_maintenance'];
export const CANONICAL_TABLES = Object.freeze(['shifts', 'shift_members', 'line_truck_statuses']);
export const CANONICAL_FUNCTIONS = Object.freeze(['shifts_legacy_bridge()', 'enforce_shift_member_role()']);
export const DEFAULT_OBJECTS = Object.freeze({ tables: CANONICAL_TABLES, functions: CANONICAL_FUNCTIONS });

function identifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value) || value.length > 63) throw new Error(`${label} is not approved`);
  return `"${value}"`;
}
function functionName(value) {
  const match = /^([a-z][a-z0-9_]*)\(\)$/.exec(value);
  if (!match) throw new Error('function is not approved');
  return `public.${identifier(match[1], 'function')}`;
}
async function setPassword(client, role, password) {
  if (typeof password !== 'string' || password.length === 0) throw new Error('role password is required');
  const { rows } = await client.query('SELECT format(\'ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L\', $1::text, $2::text) AS sql', [role, password]);
  await client.query(rows[0].sql);
}

export async function bootstrapParallelShiftRoles(client, options = {}) {
  const { runtimePassword, maintenancePassword, database = null, objects = DEFAULT_OBJECTS } = options;
  for (const table of objects.tables ?? []) {
    if (!CANONICAL_TABLES.includes(table)) throw new Error(`table ${table} is not an approved parallel-shift object`);
  }
  for (const fn of objects.functions ?? []) {
    if (!CANONICAL_FUNCTIONS.includes(fn)) throw new Error(`function ${fn} is not an approved parallel-shift object`);
  }
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='samosval_schema_owner') THEN CREATE ROLE samosval_schema_owner NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='samosval_migration_evidence_owner') THEN CREATE ROLE samosval_migration_evidence_owner NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='samosval_runtime') THEN CREATE ROLE samosval_runtime NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='samosval_maintenance') THEN CREATE ROLE samosval_maintenance NOLOGIN; END IF;
  END $$`);
  await client.query(`ALTER ROLE samosval_schema_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
    ALTER ROLE samosval_migration_evidence_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`);
  await setPassword(client, 'samosval_runtime', runtimePassword);
  await setPassword(client, 'samosval_maintenance', maintenancePassword);
  const memberships = await client.query(`SELECT g.rolname granted, u.rolname member FROM pg_auth_members a
    JOIN pg_roles g ON g.oid=a.roleid JOIN pg_roles u ON u.oid=a.member
    WHERE g.rolname = ANY($1) AND u.rolname = ANY($1)`, [ROLE_NAMES]);
  for (const membership of memberships.rows) {
    await client.query(`REVOKE ${identifier(membership.granted)} FROM ${identifier(membership.member)}`);
  }
  if (database && database !== 'postgres') {
    await client.query(`GRANT CONNECT ON DATABASE ${identifier(database, 'database')} TO samosval_runtime, samosval_maintenance`);
  }
  for (const table of objects.tables ?? []) {
    const q = identifier(table, 'table');
    await client.query(`DO $$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN REVOKE ALL ON TABLE public.${q} FROM samosval_runtime, samosval_maintenance; END IF; END $$`);
    await client.query(`DO $$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ALTER TABLE public.${q} OWNER TO samosval_schema_owner; END IF; END $$`);
  }
  for (const fn of objects.functions ?? []) {
    const q = functionName(fn);
    await client.query(`DO $$ BEGIN IF to_regprocedure('public.${fn}') IS NOT NULL THEN REVOKE ALL ON FUNCTION ${q} FROM PUBLIC, samosval_runtime, samosval_maintenance; ALTER FUNCTION ${q} OWNER TO samosval_schema_owner; END IF; END $$`);
  }
  // USAGE on the schema is not a table privilege: it only lets the role resolve a
  // relation name at all. `samosval_schema_owner` owns `shifts`, `shift_members`
  // and `line_truck_statuses`, and PostgreSQL runs their referential-integrity
  // checks as the table owner, so without USAGE every FK check on those tables
  // fails with `42501 permission denied for schema public` — while the writer's
  // own privilege on the target table is correct. A stock `public` grants USAGE
  // to PUBLIC and hides this; a schema recreated with an explicit ACL (the
  // isolated harness, or a window that revokes extra rights) does not.
  await client.query('GRANT USAGE ON SCHEMA public TO samosval_runtime, samosval_schema_owner, samosval_migration_evidence_owner');
  for (const table of objects.tables ?? []) {
    const q = identifier(table, 'table');
    await client.query(`DO $$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN GRANT SELECT ON TABLE public.${q} TO samosval_runtime; END IF; END $$`);
  }
}

export async function verifyParallelShiftRoleBoundary(client, expected = {}) {
  const roles = await client.query(`SELECT r.rolname, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls, r.rolcanlogin AS canlogin,
    COALESCE(array_agg(g.rolname::text ORDER BY g.rolname) FILTER (WHERE g.rolname IS NOT NULL), ARRAY[]::text[]) AS "memberOf"
    FROM pg_roles r LEFT JOIN pg_auth_members m ON m.member=r.oid LEFT JOIN pg_roles g ON g.oid=m.roleid
    WHERE r.rolname = ANY($1) GROUP BY r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin`, [ROLE_NAMES]);
  const byName = Object.fromEntries(roles.rows.map(row => [row.rolname, { superuser: row.superuser, bypassrls: row.bypassrls, canlogin: row.canlogin, memberOf: Array.from(row.memberOf ?? []) }]));
  const owned = await client.query(`SELECT owner.rolname AS owner, n.nspname||'.'||c.relname AS object FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles owner ON owner.oid=c.relowner WHERE owner.rolname IN ('samosval_runtime','samosval_maintenance') AND n.nspname NOT IN ('pg_catalog','information_schema') UNION ALL SELECT owner.rolname, n.nspname||'.'||p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles owner ON owner.oid=p.proowner WHERE owner.rolname IN ('samosval_runtime','samosval_maintenance') AND n.nspname NOT IN ('pg_catalog','information_schema')`);
  const functionExecute = {};
  for (const fn of expected.functions ?? DEFAULT_OBJECTS.functions) {
    const result = await client.query(`SELECT CASE WHEN to_regprocedure($1) IS NULL THEN false
      ELSE has_function_privilege($2, to_regprocedure($1), 'EXECUTE') END AS allowed`, [`public.${fn}`, 'public']);
    const runtime = await client.query(`SELECT CASE WHEN to_regprocedure($1) IS NULL THEN false ELSE has_function_privilege($2, to_regprocedure($1), 'EXECUTE') END AS allowed`, [`public.${fn}`, 'samosval_runtime']);
    const maintenance = await client.query(`SELECT CASE WHEN to_regprocedure($1) IS NULL THEN false ELSE has_function_privilege($2, to_regprocedure($1), 'EXECUTE') END AS allowed`, [`public.${fn}`, 'samosval_maintenance']);
    functionExecute[fn] = { public: result.rows[0]?.allowed === true, runtime: runtime.rows[0]?.allowed === true, maintenance: maintenance.rows[0]?.allowed === true };
  }
  const report = { roles: { runtime: byName.samosval_runtime, maintenance: byName.samosval_maintenance, schemaOwner: byName.samosval_schema_owner, evidenceOwner: byName.samosval_migration_evidence_owner }, owners: { runtimeOwnedObjects: owned.rows.filter(r => r.owner === 'samosval_runtime').map(r => r.object), maintenanceOwnedObjects: owned.rows.filter(r => r.owner === 'samosval_maintenance').map(r => r.object) }, functionExecute };
  const violations = [];
  for (const name of ['runtime', 'maintenance']) {
    if (!report.roles[name] || report.roles[name].superuser) violations.push(`${name} must not be superuser`);
    if (!report.roles[name] || report.roles[name].bypassrls) violations.push(`${name} must not bypassrls`);
    if (report.roles[name]?.canlogin !== true) violations.push(`${name} must be login`);
  }
  for (const name of ['schemaOwner', 'evidenceOwner']) {
    if (!report.roles[name] || report.roles[name].canlogin === true) violations.push(`${name} must not be login`);
  }
  for (const [name, role] of Object.entries(report.roles)) if (!role || role.memberOf.length) violations.push(`${name} must have no memberships`);
  for (const name of ['runtimeOwnedObjects', 'maintenanceOwnedObjects']) if (report.owners[name].length) violations.push(`${name} must be empty`);
  for (const [fn, subjects] of Object.entries(functionExecute)) for (const [subject, allowed] of Object.entries(subjects)) if (allowed) violations.push(`${subject} has EXECUTE on ${fn}`);
  return { ...report, violations };
}

if (process.argv[1]?.endsWith('parallel-shifts-role-bootstrap.mjs')) {
  const url = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL;
  const runtimePassword = process.env.SAMOSVAL_TEST_RUNTIME_PASSWORD;
  const maintenancePassword = process.env.SAMOSVAL_TEST_MAINTENANCE_PASSWORD;
  let client = null;
  try {
    if (!url) throw new Error('SAMOSVAL_TEST_BOOTSTRAP_URL is required');
    client = new Client({ connectionString: url }); await client.connect();
    await bootstrapParallelShiftRoles(client, { runtimePassword, maintenancePassword, database: new URL(url).pathname.slice(1) });
    const report = await verifyParallelShiftRoleBoundary(client); console.log(JSON.stringify(report));
    if (report.violations.length > 0) process.exitCode = 1;
  } catch (error) { console.error(`role boundary failed: ${error.message}`); process.exitCode = 1; }
  finally { if (client) await client.end().catch(() => {}); }
}
