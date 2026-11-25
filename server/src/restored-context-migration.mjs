// Legacy restored-row migration entrypoint (Task 7, design §4.6).
//
// The database owns every decision: `restored_context_source_manifest(...)` builds
// the exact hash-only manifest from the locked-source plan, and
// `migrate_legacy_restored_context_exact(...)` re-verifies that manifest against
// the locked rows before copying, proving and deleting anything. This module only
// carries the locator, parses the manifest, and opens/closes the maintenance
// window in which the executor may call the exact mutation function.
import { createHash } from 'node:crypto';

export const MANIFEST_SCHEMA = 'samosval.restored-context-migration/v1';
export const MIGRATION_FUNCTION = 'public.migrate_legacy_restored_context_exact(text,jsonb)';
export const MANIFEST_FUNCTION = 'public.restored_context_source_manifest(text,text,text,bigint,text)';
export const PLAN_FUNCTION = 'public.restored_context_migration_plan(text,text,text,bigint,text)';
export const EVIDENCE_OWNER = 'samosval_migration_evidence_owner';
export const MAINTENANCE_ROLE = 'samosval_maintenance';
export const RUNTIME_ROLE = 'samosval_runtime';

const OPERATION_ID = /^[A-Za-z0-9_-]{1,160}$/;

function fail(message) {
  const error = new Error(message);
  error.code = 'migration-locator-invalid';
  return error;
}

// Exact locator of one legacy restored row. Nothing is inferred from object, date
// or name: the caller names the shift, the archive series and the base revision.
export function migrationLocator(input = {}) {
  const locator = {
    workspaceId: input.workspaceId,
    legacyShiftId: input.legacyShiftId,
    archiveId: input.archiveId,
    baseArchiveRevision: Number(input.baseArchiveRevision),
    migrationOperationId: input.migrationOperationId,
  };
  for (const key of ['workspaceId', 'legacyShiftId', 'archiveId']) {
    if (typeof locator[key] !== 'string' || locator[key].length < 1 || locator[key].length > 160) {
      throw fail(`locator ${key} must be a non-empty string of at most 160 characters`);
    }
  }
  if (!Number.isInteger(locator.baseArchiveRevision) || locator.baseArchiveRevision < 1) {
    throw fail('locator baseArchiveRevision must be a positive integer');
  }
  if (typeof locator.migrationOperationId !== 'string' || !OPERATION_ID.test(locator.migrationOperationId)) {
    throw fail('locator migrationOperationId must match ^[A-Za-z0-9_-]{1,160}$');
  }
  return locator;
}

function locatorArgs(locator) {
  return [
    locator.workspaceId,
    locator.legacyShiftId,
    locator.archiveId,
    locator.baseArchiveRevision,
    locator.migrationOperationId,
  ];
}

// Reads the hash-only manifest. The result is JSON text from the database; the
// caller must pass it back byte-for-byte to the mutation entrypoint.
export async function readMigrationManifest(db, input) {
  const locator = migrationLocator(input);
  const { rows } = await db.query(
    `SELECT public.restored_context_source_manifest($1,$2,$3,$4,$5) AS manifest`,
    locatorArgs(locator),
  );
  const manifest = rows[0]?.manifest;
  if (typeof manifest !== 'string') throw fail('the database returned no migration manifest');
  return manifest;
}

export function parseMigrationManifest(text) {
  const manifest = typeof text === 'string' ? JSON.parse(text) : text;
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA) {
    throw fail(`manifest schema must be ${MANIFEST_SCHEMA}`);
  }
  return manifest;
}

// One exact migration of one legacy restored row. The manifest must be the exact
// object read by readMigrationManifest for the same locator; the database compares
// it structurally and refuses any drift.
export async function migrateLegacyRestoredContextExact(db, workspaceId, manifest) {
  const { rows } = await db.query(
    `SELECT public.migrate_legacy_restored_context_exact($1,$2::jsonb) AS result`,
    [workspaceId, typeof manifest === 'string' ? manifest : JSON.stringify(manifest)],
  );
  return rows[0]?.result;
}

// Stable sha256 of the manifest text, for operator logs and CI receipts.
export function manifestSha256(manifest) {
  const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function hasExecute(db, role, signature) {
  const { rows } = await db.query(
    `SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed`,
    [role, signature],
  );
  return rows[0]?.allowed === true;
}

// Effective privilege facts for the authority boundary. Read-only.
export async function migrationAuthorityReport(db) {
  const { rows } = await db.query(
    `SELECT p.prosecdef AS security_definer,
            pg_get_userbyid(p.proowner) AS owner,
            coalesce(array_to_string(p.proconfig, ','), '') AS config,
            p.provolatile AS volatility
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'migrate_legacy_restored_context_exact'`,
  );
  const fn = rows[0] ?? {};
  const report = {
    owner: fn.owner ?? null,
    securityDefiner: fn.security_definer === true,
    searchPath: fn.config ?? '',
    runtimeExecute: await hasExecute(db, RUNTIME_ROLE, MIGRATION_FUNCTION),
    maintenanceExecute: await hasExecute(db, MAINTENANCE_ROLE, MIGRATION_FUNCTION),
    maintenanceManifestExecute: await hasExecute(db, MAINTENANCE_ROLE, MANIFEST_FUNCTION),
  };
  const { rows: publicGrant } = await db.query(
    `SELECT count(*)::int AS n
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = $1::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`,
    [MIGRATION_FUNCTION],
  );
  report.publicExecute = (publicGrant[0]?.n ?? 0) > 0;
  return report;
}

// Opens the maintenance window: the executor receives EXECUTE on the exact
// mutation signature, the effective privilege is proven, the work runs, and the
// grant is revoked again with a second effective-privilege proof. The window
// itself never grants the runtime role and never touches function ownership.
export async function withMigrationMaintenanceWindow(db, work) {
  const before = await hasExecute(db, MAINTENANCE_ROLE, MIGRATION_FUNCTION);
  if (before) throw fail(`${MAINTENANCE_ROLE} already holds EXECUTE outside the maintenance window`);
  if (await hasExecute(db, RUNTIME_ROLE, MIGRATION_FUNCTION)) {
    throw fail(`${RUNTIME_ROLE} must never hold EXECUTE on the migration entrypoint`);
  }
  await db.query(`GRANT EXECUTE ON FUNCTION ${MIGRATION_FUNCTION} TO ${MAINTENANCE_ROLE}`);
  try {
    if (!(await hasExecute(db, MAINTENANCE_ROLE, MIGRATION_FUNCTION))) {
      throw fail('the maintenance grant did not take effect');
    }
    return await work();
  } finally {
    await db.query(`REVOKE EXECUTE ON FUNCTION ${MIGRATION_FUNCTION} FROM ${MAINTENANCE_ROLE}`);
    if (await hasExecute(db, MAINTENANCE_ROLE, MIGRATION_FUNCTION)) {
      throw fail('the maintenance grant was not revoked');
    }
  }
}
