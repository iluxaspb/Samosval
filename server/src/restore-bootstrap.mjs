// Privileged restore bootstrap (design §4.10, "Full exact backup/restore policy").
//
// Restore is split in two steps. The privileged bootstrap runs BEFORE any data
// transaction as an allowlisted deployment step: it creates/verifies roles,
// schema, extensions, functions, grants and the migration/authority registry up
// to the exact manifest versions, publishes a fingerprint, and never reads
// bundle data, never creates an application user/owner account/registration
// code, and never touches a workspace or `restore_epoch`.
//
// The data path (`restoreReplicaExact`) then only *verifies* that fingerprint.
// It has no CREATE ROLE, no role membership, no DDL/function replacement and no
// path to create the first admin/role/code: a missing or different bootstrap is
// a stable `restore-bootstrap-required` failure raised before checkpoint, DELETE,
// INSERT or `restore_epoch` mutation.
import { createHash } from 'node:crypto';

import { fail } from './tabel-access.mjs';

export const BOOTSTRAP_VERSION = 1;
// Roles the parallel-shift boundary consists of. `samosval_schema_owner` and
// `samosval_migration_evidence_owner` are NOLOGIN; runtime/maintenance are LOGIN
// and never inherit another role.
export const BOOTSTRAP_ROLES = Object.freeze([
  'samosval_schema_owner',
  'samosval_migration_evidence_owner',
  'samosval_runtime',
  'samosval_maintenance',
]);
// Every relation the exact bundle depends on. A missing one is reported in the
// failure details; the fingerprint digest itself covers the real schema.
export const REQUIRED_RELATIONS = Object.freeze([
  'workspaces', 'app_users', 'role_permissions', 'role_permission_versions',
  'registration_requests', 'identity_state', 'schema_migrations',
  'workspace_objects', 'line_trucks', 'truck_phones',
  'shifts', 'shift_members', 'line_truck_statuses', 'line_logs', 'line_history',
  'tabel_records', 'tabel_receipts', 'game_records',
  'workspace_settings', 'workspace_aux_records', 'workspace_service_audit',
  'workspace_service_receipts', 'archive_overrides', 'shift_archives',
  'shift_operation_receipts', 'line_audit', 'line_operation_receipts',
  'history_receipts', 'history_audit',
  'shift_archive_series', 'shift_archive_revisions', 'archive_operation_receipts',
  'archive_revision_publications', 'archive_audit',
  'restored_shift_contexts', 'restored_context_logs',
  'restored_context_status_snapshots', 'restored_context_history',
  'restored_context_receipts', 'restored_context_audit',
  'restored_context_migration_evidence', 'restored_context_migration_evidence_rows',
  'legacy_historicalization_confirmations', 'legacy_line_status_snapshots',
  'legacy_cutover_historicalization_audit', 'shift_legacy_resolution_guard',
  'shift_legacy_resolution_receipts', 'shift_legacy_resolution_audit',
  'replica_stream', 'replica_cursor', 'replica_document_heads',
  'replica_pending_documents', 'server_authority',
]);
// Functions whose exact body/owner/SECURITY DEFINER/search_path are part of the
// privileged bootstrap. A replaced body is a different bootstrap.
export const REQUIRED_FUNCTIONS = Object.freeze([
  'shifts_legacy_bridge()',
  'shifts_manual_provenance_guard()',
  'enforce_shift_member_role()',
  'set_history_epoch()',
  'archive_immutable_guard()',
  'legacy_append_only_guard()',
  'replica_head_pending_invariant()',
  'replica_stream_immutable_guard()',
]);

// Stable canonical JSON: the fingerprint digest must not depend on key order or
// on the order PostgreSQL happens to return rows in.
function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('bootstrap-fingerprint-nonfinite');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw fail('bootstrap-fingerprint-unsupported');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const digestOf = value => sha256(canonicalJson(value));

async function roleFacts(db) {
  const names = [...BOOTSTRAP_ROLES];
  const rows = (await db.query(
    `SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
            r.rolcanlogin AS canlogin, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
            r.rolinherit AS inherit,
            COALESCE(array_agg(g.rolname::text ORDER BY g.rolname)
                     FILTER (WHERE g.rolname IS NOT NULL), ARRAY[]::text[]) AS "memberOf"
       FROM pg_roles r
       LEFT JOIN pg_auth_members m ON m.member = r.oid
       LEFT JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = ANY($1)
      GROUP BY r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin, r.rolcreatedb,
               r.rolcreaterole, r.rolinherit
      ORDER BY r.rolname`,
    [names],
  )).rows;
  const present = new Map(rows.map(row => [row.name, row]));
  return names.map(name => {
    const row = present.get(name);
    if (!row) return { name, present: false };
    return {
      name,
      present: true,
      superuser: row.superuser === true,
      bypassrls: row.bypassrls === true,
      canlogin: row.canlogin === true,
      createdb: row.createdb === true,
      createrole: row.createrole === true,
      inherit: row.inherit === true,
      memberOf: Array.from(row.memberOf ?? []),
    };
  });
}

async function relationFacts(db) {
  return (await db.query(
    `SELECT c.relname AS name,
            pg_get_userbyid(c.relowner) AS owner,
            COALESCE((
              SELECT string_agg(a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
                                || ':' || a.attnotnull::text || ':' || a.attidentity::text, ','
                                ORDER BY a.attnum)
                FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '') AS columns,
            COALESCE((
              SELECT string_agg(k.conname::text || ':' || k.contype::text || ':' || pg_get_constraintdef(k.oid), '|'
                                ORDER BY k.conname)
                FROM pg_constraint k WHERE k.conrelid = c.oid), '') AS constraints,
            COALESCE((
              SELECT string_agg(t.tgname::text || ':' || pg_get_triggerdef(t.oid), '|' ORDER BY t.tgname)
                FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal), '') AS triggers
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
  )).rows;
}

async function functionFacts(db) {
  return (await db.query(
    `SELECT p.oid::regprocedure::text AS signature,
            pg_get_userbyid(p.proowner) AS owner,
            p.prosecdef AS security_definer,
            p.provolatile AS volatility,
            COALESCE(array_to_string(p.proconfig, ','), '') AS config,
            md5(p.prosrc) AS body
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
      ORDER BY 1`,
  )).rows.map(row => ({
    signature: row.signature,
    owner: row.owner,
    securityDefiner: row.security_definer === true,
    volatility: row.volatility,
    config: row.config,
    body: row.body,
  }));
}

async function extensionFacts(db) {
  return (await db.query(
    'SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname',
  )).rows;
}

// Effective table privileges per boundary role: a grant drift is a different
// bootstrap even when every column and constraint is unchanged.
async function grantFacts(db) {
  const roles = [];
  for (const role of BOOTSTRAP_ROLES) {
    const exists = (await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows[0];
    roles.push({ role, exists: Boolean(exists) });
  }
  const relations = (await db.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
  )).rows.map(row => row.name);
  const grants = {};
  for (const { role, exists } of roles) {
    if (!exists) {
      grants[role] = 'absent';
      continue;
    }
    const rows = (await db.query(
      `SELECT c.relname AS name,
              concat_ws(',',
                CASE WHEN has_table_privilege($1, c.oid, 'SELECT') THEN 'S' END,
                CASE WHEN has_table_privilege($1, c.oid, 'INSERT') THEN 'I' END,
                CASE WHEN has_table_privilege($1, c.oid, 'UPDATE') THEN 'U' END,
                CASE WHEN has_table_privilege($1, c.oid, 'DELETE') THEN 'D' END,
                CASE WHEN has_table_privilege($1, c.oid, 'TRUNCATE') THEN 'T' END) AS privs
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`,
      [role],
    )).rows;
    grants[role] = Object.fromEntries(rows.map(row => [row.name, row.privs]));
  }
  return { roles, grants };
}

// Migration/authority registry: the exact applied migration filenames. The
// per-workspace authority row is bundle data, not bootstrap state.
async function registryFacts(db) {
  const present = (await db.query("SELECT to_regclass('public.schema_migrations') AS relation")).rows[0];
  if (!present?.relation) return { migrations: null };
  return {
    migrations: (await db.query(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    )).rows.map(row => row.filename),
  };
}

async function aspectsOf(db) {
  return {
    roles: await roleFacts(db),
    relations: await relationFacts(db),
    functions: await functionFacts(db),
    extensions: await extensionFacts(db),
    grants: await grantFacts(db),
    registry: await registryFacts(db),
  };
}

async function missingFacts(db, aspects) {
  const relations = new Set(aspects.relations.map(row => row.name));
  const functions = new Set(aspects.functions.map(row => row.signature));
  return {
    relations: REQUIRED_RELATIONS.filter(name => !relations.has(name)),
    functions: REQUIRED_FUNCTIONS.filter(name => !functions.has(name)),
  };
}

/**
 * Publishes the privileged-bootstrap fingerprint. Read-only: it creates nothing,
 * reads no bundle data and never touches a workspace or `restore_epoch`.
 *
 * Only per-aspect digests are stored, so a mismatch can name the drifting aspect
 * without shipping the whole schema description inside every backup.
 */
export async function computeBootstrapFingerprint(db) {
  const aspects = await aspectsOf(db);
  const digests = Object.fromEntries(
    Object.entries(aspects).map(([name, value]) => [name, digestOf(value)]),
  );
  const missing = await missingFacts(db, aspects);
  const fingerprint = {
    version: BOOTSTRAP_VERSION,
    aspects: digests,
    missing,
  };
  fingerprint.digest = digestOf({ version: BOOTSTRAP_VERSION, aspects: digests });
  return fingerprint;
}

export const BOOTSTRAP_REQUIRED = 'restore-bootstrap-required';

function bootstrapFailure(reason, details = {}) {
  const error = fail(BOOTSTRAP_REQUIRED, 409);
  error.details = { reason, ...details };
  return error;
}

/**
 * Fail-closed verification of the bootstrap fingerprint before the data
 * transaction (and again inside it, before the first mutation).
 *
 * `expected` is the fingerprint captured with the bundle. A missing, malformed,
 * older-version or different fingerprint is `restore-bootstrap-required`: the
 * data path may never repair the schema, create a role or invent an admin.
 */
export async function verifyRestoreBootstrap(db, expected, options = {}) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw bootstrapFailure('bootstrap-fingerprint-missing');
  }
  if (expected.version !== BOOTSTRAP_VERSION) {
    throw bootstrapFailure('bootstrap-version-mismatch', {
      expected: expected.version ?? null,
      actual: BOOTSTRAP_VERSION,
    });
  }
  if (typeof expected.digest !== 'string' || !/^[0-9a-f]{64}$/.test(expected.digest)) {
    throw bootstrapFailure('bootstrap-fingerprint-malformed');
  }
  const actual = await computeBootstrapFingerprint(db);
  if (actual.digest !== expected.digest) {
    const drifted = Object.keys(actual.aspects).filter(
      name => expected.aspects?.[name] !== actual.aspects[name],
    );
    throw bootstrapFailure('bootstrap-fingerprint-mismatch', {
      drifted,
      missing: actual.missing,
      workspaceId: options.workspaceId ?? null,
    });
  }
  return actual;
}

// The bootstrap step itself is a deployment action, not part of the data path.
// Keeping the allowlist here makes "the data path cannot create a role" explicit
// rather than a property of whoever happens to run the restore.
export const BOOTSTRAP_STEP_OBJECTS = Object.freeze({
  roles: BOOTSTRAP_ROLES,
  relations: REQUIRED_RELATIONS,
  functions: REQUIRED_FUNCTIONS,
});
