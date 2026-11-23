import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_DATABASE_PREFIX, validateGeneratedIdentifier } from './safety.mjs';

const OWNER = 'samosval_test_prepared_owner';
const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', '..', 'sql');

function numberOf(filename) { const match = /^(\d{3})_.*\.sql$/.exec(filename); return match ? Number(match[1]) : null; }

export const EXPECTED_S24_REGISTRY = Object.freeze(readdirSync(sqlDir)
  .filter(f => numberOf(f) !== null && numberOf(f) <= 24)
  .sort()
  .map(filename => Object.freeze({ filename, checksum: createHash('sha256').update(readFileSync(join(sqlDir, filename))).digest('hex') })));
export const EXPECTED_S24_HASH = createHash('sha256').update(JSON.stringify(EXPECTED_S24_REGISTRY)).digest('hex');

function templateName(runid, suffix) {
  const database = `${GENERATED_DATABASE_PREFIX}${runid}_${suffix}`;
  validateGeneratedIdentifier(database, { runid, kind: 'template' });
  return database;
}

export async function verifyS24Target(query) {
  if (typeof query !== 'function') throw new Error('S24 verifier query is not approved');
  const rows = (await query(`SELECT filename,checksum FROM schema_migrations WHERE filename ~ '^[0-9]{3}_' ORDER BY filename`)).rows;
  if (JSON.stringify(rows) !== JSON.stringify(EXPECTED_S24_REGISTRY)) throw new Error('S24 migration registry verification failed closed');
  const schema = (await query(`SELECT to_regclass('public.workspaces') IS NOT NULL workspaces,to_regclass('public.app_users') IS NOT NULL users,to_regclass('public.server_authority') IS NOT NULL authority,to_regclass('public.replica_stream') IS NOT NULL replica,to_regclass('public.truck_phones') IS NOT NULL phones`)).rows[0];
  if (!schema || Object.values(schema).some(v => v !== true)) throw new Error('S24 schema verification failed closed');
  return Object.freeze({ count: rows.length, version: 24, registryHash: EXPECTED_S24_HASH });
}

export async function verifyTargetAuthority(query) {
  if (typeof query !== 'function') throw new Error('authority verifier query is not approved');
  const row = (await query(`SELECT
    (SELECT count(*)::int FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') AND o.rolname<>$1) wrong_object_owners,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND o.rolname<>$1) wrong_function_owners,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relacl::text ~ '(samosval_test_app|samosval_test_runtime|samosval_test_orchestrator)') broad_object_acl,
    (SELECT count(*)::int FROM pg_namespace n WHERE n.nspname='public' AND n.nspacl::text ~ '(samosval_test_app|samosval_test_runtime|samosval_test_orchestrator)') broad_schema_acl,
    (SELECT count(*)::int FROM pg_default_acl) default_acl_entries`, [OWNER])).rows[0];
  if (!row || row.wrong_object_owners !== 0 || row.wrong_function_owners !== 0
      || row.broad_object_acl !== 0 || row.broad_schema_acl !== 0 || row.default_acl_entries !== 0) {
    throw new Error('target authority verification failed closed');
  }
  return Object.freeze({ objectsOwned: true, functionsOwned: true, objectAclSafe: true, schemaAclSafe: true, defaultAclSafe: true });
}

function safeDatabaseAcl(datacl) {
  if (typeof datacl !== 'string' || datacl.length === 0) return false;
  const body = datacl.slice(datacl.startsWith('{') ? 1 : 0, datacl.endsWith('}') ? -1 : undefined);
  return body.split(',').every(item => {
    const separator = item.indexOf('=');
    const grantor = item.indexOf('/');
    if (separator < 0 || grantor < separator) return false;
    const grantee = item.slice(0, separator);
    const privileges = item.slice(separator + 1, grantor);
    if (['samosval_test_app', 'samosval_test_orchestrator', 'samosval_test_runtime'].includes(grantee)) return false;
    // PUBLIC may only retain TEMP; CONNECT or CREATE would open a mutation path.
    if (grantee === '') return !/[Cc]/.test(privileges);
    return true;
  });
}

export async function inspectTemplateSeal(queryCatalog, database, expectedComment) {
  if (typeof queryCatalog !== 'function') throw new Error('catalog inspection query is not approved');
  const row = (await queryCatalog(`SELECT
    owner.rolname owner, owner.rolsuper super, owner.rolcreatedb createdb, owner.rolcreaterole createrole, owner.rolcanlogin canlogin,
    d.datallowconn allow_connections, d.datacl::text datacl, description.description comment,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) sessions,
    (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid WHERE member_role.rolname=$1) memberships
    FROM pg_database d
    JOIN pg_roles owner ON owner.oid=d.datdba
    JOIN pg_roles member_role ON member_role.rolname=$1
    LEFT JOIN pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_catalog.pg_database'::regclass
    WHERE d.datname=$2`, [OWNER, database])).rows[0];
  if (!row || row.owner !== OWNER || row.super !== false || row.createdb !== false || row.createrole !== false
      || row.canlogin !== false || row.allow_connections !== false || row.sessions !== 0 || row.memberships !== 0
      || row.comment !== expectedComment
      || !safeDatabaseAcl(row.datacl)) {
    throw new Error('template verification failed closed');
  }
  return Object.freeze({ owner: row.owner, comment: row.comment, allowConnections: false, sessions: 0 });
}

function record(kind, database, source, version, registryHash, comment) {
  return Object.freeze({ kind, database, source, version, registryHash, owner: OWNER, comment, immutable: true });
}

export async function prepareTemplates(context) {
  if (!context || typeof context.templateOperation !== 'function' || typeof context.migrateTemplate !== 'function'
      || typeof context.queryTemplate !== 'function' || typeof context.queryCatalog !== 'function') throw new Error('template context is not approved');
  const { runid } = context;
  const empty = templateName(runid, 'tpl_empty');
  const s24 = templateName(runid, 'tpl_s24');
  await context.templateOperation({ operation: 'createTemplate', database: empty, source: 'template0' });
  const emptySeal = await context.templateOperation({ operation: 'freezeTemplate', database: empty, registryHash: 'empty' });
  await inspectTemplateSeal(context.queryCatalog, empty, emptySeal.comment);
  await context.templateOperation({ operation: 'createTemplate', database: s24, source: empty });
  await context.migrateTemplate({ database: s24, through: 24 });
  const migration = await verifyS24Target((text, values) => context.queryTemplate(s24, text, values));
  await verifyTargetAuthority((text, values) => context.queryTemplate(s24, text, values));
  const s24Seal = await context.templateOperation({ operation: 'freezeTemplate', database: s24, registryHash: migration.registryHash });
  await inspectTemplateSeal(context.queryCatalog, s24, s24Seal.comment);
  return new Map([
    ['empty', record('empty', empty, 'template0', 0, 'empty', emptySeal.comment)],
    ['S24', record('S24', s24, empty, 24, migration.registryHash, s24Seal.comment)],
  ]);
}
