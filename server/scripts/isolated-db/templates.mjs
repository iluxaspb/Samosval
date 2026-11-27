import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_BACKEND_FILTER, GENERATED_DATABASE_PREFIX, validateGeneratedIdentifier } from './safety.mjs';

const OWNER = 'samosval_test_prepared_owner';
const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', '..', 'sql');

function numberOf(filename) { const match = /^(\d{3})_.*\.sql$/.exec(filename); return match ? Number(match[1]) : null; }

export const EXPECTED_S24_REGISTRY = Object.freeze(readdirSync(sqlDir)
  .filter(f => numberOf(f) !== null && numberOf(f) <= 24)
  .sort()
  .map(filename => Object.freeze({ filename, checksum: createHash('sha256').update(readFileSync(join(sqlDir, filename))).digest('hex') })));
export const EXPECTED_S24_HASH = createHash('sha256').update(JSON.stringify(EXPECTED_S24_REGISTRY)).digest('hex');

// S25 = S24 + exactly one redesigned product migration (025). The registry is
// derived from the real files on disk, never from a hand-written checksum, so a
// drifted 025 fails closed in the template verifier below.
export const EXPECTED_S25_REGISTRY = Object.freeze(readdirSync(sqlDir)
  .filter(f => numberOf(f) !== null && numberOf(f) <= 25)
  .sort()
  .map(filename => Object.freeze({ filename, checksum: createHash('sha256').update(readFileSync(join(sqlDir, filename))).digest('hex') })));
export const EXPECTED_S25_HASH = createHash('sha256').update(JSON.stringify(EXPECTED_S25_REGISTRY)).digest('hex');

export const EXPECTED_S26_REGISTRY = Object.freeze(readdirSync(sqlDir)
  .filter(f => numberOf(f) !== null && numberOf(f) <= 26)
  .sort()
  .map(filename => Object.freeze({ filename, checksum: createHash('sha256').update(readFileSync(join(sqlDir, filename))).digest('hex') })));
export const EXPECTED_S26_HASH = createHash('sha256').update(JSON.stringify(EXPECTED_S26_REGISTRY)).digest('hex');
export const S26_KEY_OBJECTS = Object.freeze(['replica_document_heads', 'replica_pending_documents']);
export const S26_KEY_TRIGGERS = Object.freeze(['replica_document_heads_pending_invariant', 'replica_pending_documents_head_invariant']);

// Key 025 objects and enabled triggers, named explicitly. A template that merely
// claims version 25 but lacks one of these is rejected.
export const S25_KEY_OBJECTS = Object.freeze([
  'restored_shift_contexts',
  'shift_archive_series',
  'shift_archive_revisions',
  'archive_revision_publications',
  'archive_operation_receipts',
  'restored_context_migration_evidence',
  'restored_context_migration_evidence_rows',
]);
export const S25_KEY_TRIGGERS = Object.freeze([
  'shifts_manual_provenance_guard_trigger',
  'shift_archive_revisions_append_only',
  'archive_operation_receipts_append_only',
  'archive_revision_publications_append_only',
  'restored_context_migration_evidence_append_only',
]);
export const S25_MIGRATE_FUNCTION = 'public.migrate_legacy_restored_context_exact(text,jsonb)';

// Templates are cloned tip-from-base (empty → S24 → S25 → S26), so they must be
// dropped in the reverse order: a template cannot be dropped while a database
// cloned from it still exists. This is the single source of that order.
const TEMPLATE_DROP_ORDER = Object.freeze(['S26', 'S25', 'S24', 'empty']);

export function templateDropOrder(kinds) {
  if (!Array.isArray(kinds)) throw new Error('template kinds are not approved');
  const present = new Set(kinds);
  for (const kind of present) {
    if (!TEMPLATE_DROP_ORDER.includes(kind)) throw new Error(`unknown template kind: ${kind}`);
  }
  return TEMPLATE_DROP_ORDER.filter(kind => present.has(kind));
}

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

// S25 fails closed on the real registry and the real 025 surface: the last
// migration must be 025 with the exact file checksum, the key objects must
// exist, the exact migration function must be installed and the D12/append-only
// triggers must be enabled. Nothing here trusts the version number alone.
export async function verifyS25Target(query) {
  if (typeof query !== 'function') throw new Error('S25 verifier query is not approved');
  const rows = (await query(`SELECT filename,checksum FROM schema_migrations WHERE filename ~ '^[0-9]{3}_' ORDER BY filename`)).rows;
  if (JSON.stringify(rows) !== JSON.stringify(EXPECTED_S25_REGISTRY)) throw new Error('S25 migration registry verification failed closed');
  const last = rows[rows.length - 1];
  if (!last || last.filename !== '025_parallel_shifts_core.sql') throw new Error('S25 migration registry verification failed closed');
  const schema = (await query(`SELECT
    to_regclass('public.workspaces') IS NOT NULL workspaces,
    to_regclass('public.app_users') IS NOT NULL users,
    to_regclass('public.server_authority') IS NOT NULL authority,
    to_regclass('public.replica_stream') IS NOT NULL replica,
    to_regclass('public.truck_phones') IS NOT NULL phones`)).rows[0];
  if (!schema || Object.values(schema).some(v => v !== true)) throw new Error('S25 schema verification failed closed');
  const objects = (await query(`SELECT count(*)::int AS present FROM unnest($1::text[]) AS target(name) WHERE to_regclass('public.' || target.name) IS NOT NULL`, [S25_KEY_OBJECTS])).rows[0];
  if (objects?.present !== S25_KEY_OBJECTS.length) throw new Error('S25 schema verification failed closed');
  const fn = (await query(`SELECT to_regprocedure($1) IS NOT NULL AS installed`, [S25_MIGRATE_FUNCTION])).rows[0];
  if (fn?.installed !== true) throw new Error('S25 schema verification failed closed');
  const triggers = (await query(`SELECT count(*)::int AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgenabled='O' AND t.tgname = ANY($1::text[])`, [S25_KEY_TRIGGERS])).rows[0];
  if (triggers?.enabled !== S25_KEY_TRIGGERS.length) throw new Error('S25 trigger verification failed closed');
  return Object.freeze({ count: rows.length, version: 25, registryHash: EXPECTED_S25_HASH });
}

export async function verifyS26Target(query) {
  if (typeof query !== 'function') throw new Error('S26 verifier query is not approved');
  const rows = (await query(`SELECT filename,checksum FROM schema_migrations WHERE filename ~ '^[0-9]{3}_' ORDER BY filename`)).rows;
  if (JSON.stringify(rows) !== JSON.stringify(EXPECTED_S26_REGISTRY)) throw new Error('S26 migration registry verification failed closed');
  if (rows.at(-1)?.filename !== '026_parallel_shift_dependencies.sql') throw new Error('S26 migration registry verification failed closed');
  const schema = (await query(`SELECT to_regclass('public.replica_stream') IS NOT NULL stream,to_regclass('public.replica_cursor') IS NOT NULL cursor`)).rows[0];
  if (!schema || Object.values(schema).some(v => v !== true)) throw new Error('S26 schema verification failed closed');
  const objects = (await query(`SELECT count(*)::int AS present FROM unnest($1::text[]) AS target(name) WHERE to_regclass('public.' || target.name) IS NOT NULL`, [S26_KEY_OBJECTS])).rows[0];
  if (objects?.present !== S26_KEY_OBJECTS.length) throw new Error('S26 schema verification failed closed');
  const triggers = (await query(`SELECT count(*)::int AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgenabled='O' AND t.tgname = ANY($1::text[])`, [S26_KEY_TRIGGERS])).rows[0];
  if (triggers?.enabled !== S26_KEY_TRIGGERS.length) throw new Error('S26 trigger verification failed closed');
  const empty = (await query(`SELECT (SELECT count(*)::int FROM replica_stream) stream,(SELECT count(*)::int FROM replica_document_heads) heads,(SELECT count(*)::int FROM replica_pending_documents) pending`)).rows[0];
  if (empty?.stream !== 0 || empty?.heads !== 0 || empty?.pending !== 0) throw new Error('S26 staging must be empty');
  return Object.freeze({ count: rows.length, version: 26, registryHash: EXPECTED_S26_HASH });
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
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname AND ${CLIENT_BACKEND_FILTER}) sessions,
    (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE member.rolname=$1) memberships
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
  const s25 = templateName(runid, 'tpl_s25');
  const s26 = templateName(runid, 'tpl_s26');
  await context.templateOperation({ operation: 'createTemplate', database: empty, source: 'template0' });
  const emptySeal = await context.templateOperation({ operation: 'freezeTemplate', database: empty, registryHash: 'empty' });
  await inspectTemplateSeal(context.queryCatalog, empty, emptySeal.comment);
  await context.templateOperation({ operation: 'createTemplate', database: s24, source: empty });
  await context.migrateTemplate({ database: s24, through: 24 });
  const migration = await verifyS24Target((text, values) => context.queryTemplate(s24, text, values));
  await verifyTargetAuthority((text, values) => context.queryTemplate(s24, text, values));
  const s24Seal = await context.templateOperation({ operation: 'freezeTemplate', database: s24, registryHash: migration.registryHash });
  await inspectTemplateSeal(context.queryCatalog, s24, s24Seal.comment);
  // S25 is cloned from the frozen S24 and receives exactly 025. The migration
  // runner applies only the missing file, so 026 can never leak into S25.
  await context.templateOperation({ operation: 'createTemplate', database: s25, source: s24 });
  await context.migrateTemplate({ database: s25, through: 25 });
  const s25Migration = await verifyS25Target((text, values) => context.queryTemplate(s25, text, values));
  await verifyTargetAuthority((text, values) => context.queryTemplate(s25, text, values));
  const s25Seal = await context.templateOperation({ operation: 'freezeTemplate', database: s25, registryHash: s25Migration.registryHash });
  await inspectTemplateSeal(context.queryCatalog, s25, s25Seal.comment);
  await context.templateOperation({ operation: 'createTemplate', database: s26, source: s25 });
  await context.migrateTemplate({ database: s26, through: 26 });
  const s26Migration = await verifyS26Target((text, values) => context.queryTemplate(s26, text, values));
  await verifyTargetAuthority((text, values) => context.queryTemplate(s26, text, values));
  const s26Seal = await context.templateOperation({ operation: 'freezeTemplate', database: s26, registryHash: s26Migration.registryHash });
  await inspectTemplateSeal(context.queryCatalog, s26, s26Seal.comment);
  return new Map([
    ['empty', record('empty', empty, 'template0', 0, 'empty', emptySeal.comment)],
    ['S24', record('S24', s24, empty, 24, migration.registryHash, s24Seal.comment)],
    ['S25', record('S25', s25, s24, 25, s25Migration.registryHash, s25Seal.comment)],
    ['S26', record('S26', s26, s25, 26, s26Migration.registryHash, s26Seal.comment)],
  ]);
}
