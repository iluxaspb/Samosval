#!/usr/bin/env node
// Репетиция окна обслуживания параллельных смен (design §13, §4.8–§4.10).
//
// Скрипт работает ТОЛЬКО с той базой, к которой подключился, и только на
// изолированной тестовой базе: `SAMOSVAL_ISOLATED_TEST=1` плюс имя базы из
// `tests/helpers/isolated-db.mjs`. Деплой сервера, публикация PWA, restore
// общей базы и любые действия вне этой БД — не его область: такие фазы
// отвергаются кодом `out-of-scope`, их выполняет человек по runbook.
//
// Порядок фаз и предусловия (файлы в `--run-dir`):
//
//   backup      → backup/manifest.json (+ snapshot, при готовой схеме exact bundle)
//   preflight   → требует backup/manifest.json; пишет report/report.{json,sha256,txt}
//   confirm     → требует backup/manifest.json и report/report.json;
//                 принимает только точный sha256 байтов отчёта
//   migrate     → требует backup/manifest.json; без confirmation выполняет
//                 только схему (role split + 025), с confirmation — historicalization
//                 ровно по подтверждённому отчёту, затем 026 и 027
//   verify      → требует migration.json со стадией `data`
//   report      → требует verify.json; сводит итог без секретов/DSN/персональных данных
//
// Почему backup раньше preflight/confirm, а 025 применяется до preflight:
//   * `buildHistoricalizationReport` включает `backupManifestSha256` в байты
//     отчёта, а `historicalizeConfirmedLegacy` сверяет его с живым значением,
//     поэтому backup обязан существовать ДО отчёта и подтверждения;
//   * отчёт и таблица подтверждений создаются миграцией 025 (колонки
//     state/identity_resolution/…), поэтому 025 применяется до preflight;
//     design §13 п.5–6 уточнён этим фактом, а не отменён: preflight остаётся
//     read-only, а destructive historicalization по-прежнему закрыта точным
//     подтверждением и проверенным backup.
//
// По умолчанию — dry-run: печатает план и проверяет файловые предусловия,
// не открывая соединение с базой. Мутация требует явного `--apply`.
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPool, applyMigrations } from './apply-migrations.mjs';
import { bootstrapParallelShiftRoles, verifyParallelShiftRoleBoundary } from './parallel-shifts-role-bootstrap.mjs';
import { captureProvenanceBundle, verifyBundleManifest } from '../src/backup-store.mjs';
import { computeBootstrapFingerprint } from '../src/restore-bootstrap.mjs';
import {
  buildHistoricalizationReport,
  computeDatabaseFingerprint,
  historicalizeConfirmedLegacy,
  liveSchemaMigrationVersion,
  recordHistoricalizationConfirmation,
  CONSEQUENCES,
} from '../src/legacy-historicalization.mjs';

export const PHASES = Object.freeze(['backup', 'preflight', 'confirm', 'migrate', 'verify', 'report']);

// These names describe real work, but it is done by a person with an explicit
// owner approval. The script refuses them before it reads the database.
export const OUT_OF_SCOPE_PHASES = Object.freeze({
  deploy: 'deploy/publish of the server or PWA is outside this script; run it manually by the runbook',
  publish: 'deploy/publish of the server or PWA is outside this script; run it manually by the runbook',
  restore: 'restoring the shared database is destructive and outside this script; it needs a separate explicit owner approval',
});

const SNAPSHOT_FORMAT = 'samosval.maintenance-snapshot/v1';
const SNAPSHOT_FILE = 'snapshot.json';
const MANIFEST_FILE = 'manifest.json';
const EXACT_BUNDLE_FILE = 'exact-bundle.json';
const EXCLUDED_MIGRATIONS = Object.freeze(['018_auth_credentials.sql']);
const HEX64 = /^[0-9a-f]{64}$/;

function fail(code, message, exitCode = 2) {
  const error = new Error(message ?? code);
  error.code = code;
  error.exitCode = exitCode;
  error.maintenance = true;
  return error;
}

const sha256Hex = value => createHash('sha256').update(value).digest('hex');
const quoteIdent = name => `"${String(name).replaceAll('"', '""')}"`;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

// RFC 8785-like canonical JSON over an already JSON-serialized value. The
// snapshot digest must be reproducible from the file alone, so every row is
// passed through JSON first (Date → ISO string, Buffer → {type,data}).
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('canonical-non-finite-number', 'non-finite number', 1);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw fail('canonical-unsupported-value', 'unsupported value', 1);
}

function serialize(value) {
  return JSON.parse(JSON.stringify(value));
}

function tableDigest(rows) {
  return sha256Hex(canonicalJson([...rows].sort((left, right) => {
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  })));
}

// The same rule `tests/helpers/isolated-db.mjs` enforces, expressed here so that
// a maintenance script never imports test-only code (a test helper import would
// also make every unit root that touches this file a database root).
const ISOLATED_HOSTS = new Set(['postgres', 'localhost', '127.0.0.1', '[::1]']);
const ISOLATED_DATABASE = /^samosval_(?:parallel_shifts_)?test(?:_[a-f0-9]{12,20}_[a-f0-9]{12})?$/;

function connectionUrl(env) {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  const user = encodeURIComponent(env.POSTGRES_USER ?? '');
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? '');
  const host = env.PGHOST ?? 'postgres';
  const port = env.PGPORT ?? '5432';
  const database = encodeURIComponent(env.POSTGRES_DB ?? '');
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

function approvedTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const approved = ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && ISOLATED_HOSTS.has(parsed.hostname)
      && ISOLATED_DATABASE.test(database)
      && parsed.search === ''
      && parsed.hash === '';
    return approved ? { url, database } : null;
  } catch {
    return null;
  }
}

/**
 * Validate the connection target before any phase, so a rehearsal cannot
 * accidentally run on a shared database.
 */
export function assertIsolatedTarget(env = process.env) {
  if (env.SAMOSVAL_ISOLATED_TEST !== '1') {
    throw fail('isolated-test-required', 'SAMOSVAL_ISOLATED_TEST=1 is required');
  }
  const target = approvedTarget(connectionUrl(env));
  if (!target) {
    throw fail('isolated-database-required', 'the target must be an isolated samosval test database');
  }
  // The harness hands a db child a privileged bootstrap connection scoped to the
  // same generated target. It is the connection every DDL phase runs on, and it
  // may never point at another database than the one under test.
  if (env.SAMOSVAL_TEST_BOOTSTRAP_URL) {
    const admin = approvedTarget(env.SAMOSVAL_TEST_BOOTSTRAP_URL);
    if (!admin || admin.database !== target.database) {
      throw fail('isolated-database-required', 'the bootstrap connection must target the same isolated database');
    }
  }
  return target.url;
}

/**
 * Connection used for every phase: DDL (role split, migrations, historicalization)
 * cannot run as the restricted app role, so the privileged bootstrap connection
 * wins when the harness provides one. Both are already validated as isolated.
 */
export function privilegedUrl(env = process.env) {
  assertIsolatedTarget(env);
  return env.SAMOSVAL_TEST_BOOTSTRAP_URL || connectionUrl(env);
}

// ---------------------------------------------------------------------------
// Phase preconditions: files only, so dry-run and refusals never touch the DB.
// ---------------------------------------------------------------------------

export function phasePreconditions(phase, options = {}) {
  const runDir = options.runDir;
  if (!runDir) throw fail('usage', '--run-dir is required');
  const reportDir = options.reportDir ?? join(runDir, 'report');
  switch (phase) {
    case 'backup':
      return [];
    case 'preflight':
      return [join(runDir, 'backup', MANIFEST_FILE)];
    case 'confirm':
      return [
        join(runDir, 'backup', MANIFEST_FILE),
        join(reportDir, 'report.json'),
        join(reportDir, 'report.sha256'),
      ];
    case 'migrate':
      return [join(runDir, 'backup', MANIFEST_FILE)];
    case 'verify':
      return [join(runDir, 'migration.json')];
    case 'report':
      return [join(runDir, 'verify.json')];
    default:
      return [];
  }
}

export async function checkPreconditions(phase, options = {}) {
  const missing = [];
  for (const path of phasePreconditions(phase, options)) {
    if (!(await exists(path))) missing.push(path);
  }
  if (missing.length > 0) {
    throw fail('phase-order-violation', `missing prerequisite: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Snapshot of the live database (works on any schema, before 025).
// ---------------------------------------------------------------------------

async function listPublicTables(db) {
  return (await db.query(
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  )).rows.map(row => row.name);
}

async function hasColumn(db, table, column) {
  const row = (await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  )).rows[0];
  return Boolean(row);
}

async function captureSnapshot(db, workspaceId) {
  const tables = {};
  for (const table of await listPublicTables(db)) {
    const scoped = await hasColumn(db, table, 'workspace_id');
    const rows = (await db.query(
      `SELECT * FROM public.${quoteIdent(table)}${scoped ? ' WHERE workspace_id = $1' : ''}`,
      scoped ? [workspaceId] : [],
    )).rows;
    const serialized = serialize(rows);
    tables[table] = { count: serialized.length, sha256: tableDigest(serialized), rows: serialized };
  }
  return {
    format: SNAPSHOT_FORMAT,
    workspaceId,
    capturedAt: new Date().toISOString(),
    tables,
  };
}

function verifySnapshot(snapshot) {
  if (snapshot?.format !== SNAPSHOT_FORMAT) throw fail('backup-manifest-missing', 'snapshot format is unknown', 1);
  for (const [table, entry] of Object.entries(snapshot.tables ?? {})) {
    if (!Array.isArray(entry?.rows)) throw fail('backup-read-mismatch', `snapshot table ${table} has no rows`, 1);
    if (entry.count !== entry.rows.length) throw fail('backup-read-mismatch', `snapshot count drift in ${table}`, 1);
    if (tableDigest(entry.rows) !== entry.sha256) throw fail('backup-read-mismatch', `snapshot digest drift in ${table}`, 1);
  }
  return true;
}

async function schemaReadyForExactBundle(db) {
  const row = (await db.query("SELECT to_regclass('public.replica_document_heads') AS relation")).rows[0];
  return Boolean(row?.relation);
}

// A Buffer survives JSON as {type:'Buffer',data}; reviving it keeps the exact
// bundle digest computable from the file on disk (verifyBundleManifest).
function reviveBuffers(key, value) {
  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
}

async function captureExactBundle(db, workspaceId, runDir) {
  if (!(await schemaReadyForExactBundle(db))) {
    return { status: 'skipped', reason: 'schema-pre-026' };
  }
  const bundle = await captureProvenanceBundle(db, workspaceId);
  verifyBundleManifest(bundle);
  const bytes = Buffer.from(JSON.stringify(bundle));
  const sha256 = sha256Hex(bytes);
  const directory = join(runDir, 'backup');
  await writeFile(join(directory, EXACT_BUNDLE_FILE), bytes);
  await writeFile(join(directory, 'exact-bundle.sha256'), `${sha256}  ${EXACT_BUNDLE_FILE}\n`);
  // Trial read: the file on disk must reproduce the same manifest, not just the
  // in-memory object.
  const reread = await readFile(join(directory, EXACT_BUNDLE_FILE), 'utf8');
  if (sha256Hex(Buffer.from(reread)) !== sha256) throw fail('backup-read-mismatch', 'exact bundle bytes changed on disk', 1);
  const parsed = JSON.parse(reread, reviveBuffers);
  verifyBundleManifest(parsed);
  await writeJson(join(directory, 'exact-bundle.verified.json'), {
    verified: true,
    sha256,
    digest: bundle.manifest.digest,
    tables: Object.fromEntries(Object.entries(bundle.manifest.tables).map(([name, entry]) => [name, entry.count])),
    capturedAt: bundle.capturedAt,
  });
  return { status: 'verified', sha256, digest: bundle.manifest.digest };
}

async function backupPhase({ pool, runDir, workspaceId }) {
  const directory = join(runDir, 'backup');
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, MANIFEST_FILE);
  // The first snapshot is the artifact the report and confirmation are bound
  // to. A later run may add the exact bundle, but never rewrites that hash.
  if (await exists(manifestPath)) {
    const manifest = await readJson(manifestPath);
    const exact = await captureExactBundle(pool, workspaceId, runDir);
    return {
      phase: 'backup',
      reused: true,
      sha256: manifest.sha256,
      tables: manifest.tableCount,
      rows: manifest.rowCount,
      exactBundle: exact,
    };
  }
  const fingerprint = await computeDatabaseFingerprint(pool);
  const snapshot = await captureSnapshot(pool, workspaceId);
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const sha256 = sha256Hex(bytes);
  await writeFile(join(directory, SNAPSHOT_FILE), bytes);
  await writeFile(join(directory, 'snapshot.sha256'), `${sha256}  ${SNAPSHOT_FILE}\n`);
  const reread = await readFile(join(directory, SNAPSHOT_FILE), 'utf8');
  if (sha256Hex(Buffer.from(reread)) !== sha256) throw fail('backup-read-mismatch', 'snapshot bytes changed on disk', 1);
  const parsed = JSON.parse(reread);
  verifySnapshot(parsed);
  const tableCount = Object.keys(snapshot.tables).length;
  const rowCount = Object.values(snapshot.tables).reduce((sum, entry) => sum + entry.count, 0);
  const manifest = {
    format: SNAPSHOT_FORMAT,
    workspaceId,
    capturedAt: snapshot.capturedAt,
    databaseFingerprint: fingerprint,
    sha256,
    tableCount,
    rowCount,
    tables: Object.fromEntries(Object.entries(snapshot.tables).map(([name, entry]) => [name, { count: entry.count, sha256: entry.sha256 }])),
  };
  await writeJson(manifestPath, manifest);
  const exact = await captureExactBundle(pool, workspaceId, runDir);
  return { phase: 'backup', reused: false, sha256, tables: tableCount, rows: rowCount, exactBundle: exact };
}

// ---------------------------------------------------------------------------
// preflight: read-only report on the 025 schema.
// ---------------------------------------------------------------------------

async function requireSchema025(pool) {
  if (!(await hasColumn(pool, 'shifts', 'state'))) {
    throw fail('schema-not-ready', 'migration 025 must be applied by `--phase migrate --apply` (schema stage) before preflight');
  }
}

async function preflightPhase({ pool, runDir, workspaceId, expiresAt }) {
  await requireSchema025(pool);
  const manifest = await readJson(join(runDir, 'backup', MANIFEST_FILE));
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) throw fail('usage', '--expires-at must be an ISO timestamp');
  const client = await pool.connect();
  try {
    // Read-only transaction: an accidental write fails at the database level.
    await client.query('BEGIN READ ONLY');
    const liveFingerprint = await computeDatabaseFingerprint(client);
    if (liveFingerprint !== manifest.databaseFingerprint) {
      throw fail('confirmation-environment-changed', 'the database changed since the backup', 1);
    }
    const migrationVersion = await liveSchemaMigrationVersion(client);
    const built = await buildHistoricalizationReport(client, {
      workspaceId,
      migrationVersion,
      generatedAt: new Date().toISOString(),
      expiresAt,
      backupManifestSha256: manifest.sha256,
      databaseFingerprint: liveFingerprint,
    });
    await client.query('COMMIT');
    if (built.rowCount === 0) {
      return { phase: 'preflight', rowCount: 0, sha256: built.sha256, written: false };
    }
    const directory = join(runDir, 'report');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'report.json'), built.bytes);
    await writeFile(join(directory, 'report.sha256'), `${built.sha256}  report.json\n`);
    const lines = [
      `Отчёт историзации legacy-смен. Количество строк: ${built.rowCount}`,
      `SHA-256: ${built.sha256}`,
      `Срок действия: ${expiresAt}`,
      `Отпечаток БД: ${liveFingerprint}`,
      `Backup manifest: ${manifest.sha256}`,
      ...CONSEQUENCES,
    ];
    await writeFile(join(directory, 'report.txt'), `${lines.join('\n')}\n`);
    return { phase: 'preflight', rowCount: built.rowCount, sha256: built.sha256, written: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// confirm: exact report bytes/hash only, never a flag or a retelling.
// ---------------------------------------------------------------------------

async function confirmPhase({ pool, runDir, reportDir, reportSha256, ownerActorUid, confirmationId, workspaceId }) {
  if (typeof reportSha256 !== 'string' || !HEX64.test(reportSha256)) {
    throw fail('usage', '--report-sha256 must be 64 lowercase hex characters');
  }
  const directory = reportDir ?? join(runDir, 'report');
  const bytes = await readFile(join(directory, 'report.json'));
  const actual = sha256Hex(bytes);
  const recorded = (await readFile(join(directory, 'report.sha256'), 'utf8')).trim().split(/\s+/)[0];
  if (actual !== reportSha256 || actual !== recorded) {
    throw fail('report-hash-mismatch', 'report bytes do not match --report-sha256 and report.sha256');
  }
  const report = JSON.parse(bytes.toString('utf8'));
  if (report.workspaceId !== workspaceId) throw fail('report-context-mismatch', 'report workspace differs from --workspace');
  const manifest = await readJson(join(runDir, 'backup', MANIFEST_FILE));
  if (report.backupManifestSha256 !== manifest.sha256) {
    throw fail('report-backup-mismatch', 'report is bound to a different backup manifest');
  }
  const liveFingerprint = await computeDatabaseFingerprint(pool);
  if (report.databaseFingerprint !== liveFingerprint) {
    throw fail('confirmation-environment-changed', 'the database changed since the report');
  }
  const client = await pool.connect();
  try {
    const result = await recordHistoricalizationConfirmation(client, {
      confirmationId,
      reportBytes: bytes,
      reportSha256: actual,
      ownerActorUid,
      expiresAt: report.expiresAt,
      backupManifestSha256: report.backupManifestSha256,
      databaseFingerprint: report.databaseFingerprint,
    });
    await writeJson(join(runDir, 'confirmation.json'), {
      confirmationId: result.confirmationId,
      reportSha256: actual,
      rowCount: result.rowCount,
      backupManifestSha256: report.backupManifestSha256,
      confirmedAt: new Date().toISOString(),
    });
    return { phase: 'confirm', confirmationId: result.confirmationId, rowCount: result.rowCount, sha256: actual };
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// migrate: schema stage (role split + 025) then, after confirmation, the exact
// historicalization plus 026 and 027.
// ---------------------------------------------------------------------------

async function appliedMigrations(pool) {
  return new Set((await pool.query('SELECT filename FROM schema_migrations')).rows.map(row => row.filename));
}

async function bootstrapRoles(pool, env) {
  const runtimePassword = env.SAMOSVAL_TEST_RUNTIME_PASSWORD;
  const maintenancePassword = env.SAMOSVAL_TEST_MAINTENANCE_PASSWORD;
  if (!runtimePassword || !maintenancePassword) {
    throw fail('role-passwords-required', 'SAMOSVAL_TEST_RUNTIME_PASSWORD and SAMOSVAL_TEST_MAINTENANCE_PASSWORD are required for the role split');
  }
  const database = new URL(assertIsolatedTarget(env)).pathname.slice(1);
  const client = await pool.connect();
  try {
    // The rehearsal runs the very same bootstrap the window runs: no extra grant
    // is added here, so a gap in the role split shows up in the rehearsal too.
    await bootstrapParallelShiftRoles(client, { runtimePassword, maintenancePassword, database });
  } finally {
    client.release();
  }
}

async function migratePhase({ pool, env, runDir, workspaceId, maintenanceActorUid }) {
  const applied = await appliedMigrations(pool);
  const has025 = applied.has('025_parallel_shifts_core.sql');
  const confirmationPath = join(runDir, 'confirmation.json');
  if (!has025) {
    // Schema stage: role split must precede 025, and 025 classifies legacy rows
    // so that the read-only preflight can build its exact report.
    await bootstrapRoles(pool, env);
    const results = await applyMigrations(pool, {
      through: 25,
      exclude: [...EXCLUDED_MIGRATIONS],
      requireRoleBoundary: true,
    });
    // 025 creates the bridge functions, so a single bootstrap before it cannot
    // revoke their default PUBLIC EXECUTE. The role split is idempotent: running
    // it again after the migration establishes the exact boundary it promises.
    await bootstrapRoles(pool, env);
    const record = {
      stage: 'schema',
      applied: true,
      historicalized: 0,
      migrations: results.filter(item => item.status === 'applied').map(item => item.filename),
      completedAt: new Date().toISOString(),
      next: 'preflight',
    };
    await writeJson(join(runDir, 'migration.json'), record);
    return { phase: 'migrate', ...record };
  }
  if (!(await exists(confirmationPath))) {
    throw fail('confirmation-required', 'the data stage needs a confirmed exact report (--phase confirm)');
  }
  const confirmation = await readJson(confirmationPath);
  const manifest = await readJson(join(runDir, 'backup', MANIFEST_FILE));
  if (confirmation.backupManifestSha256 !== manifest.sha256) {
    throw fail('report-backup-mismatch', 'confirmation is bound to a different backup manifest');
  }
  const client = await pool.connect();
  let historicalized;
  try {
    historicalized = await historicalizeConfirmedLegacy(client, {
      confirmationId: confirmation.confirmationId,
      confirmReportSha256: confirmation.reportSha256,
      maintenanceActorUid,
      liveBackupManifestSha256: manifest.sha256,
    });
  } finally {
    client.release();
  }
  const migrations = [];
  for (const through of [26, 27]) {
    const results = await applyMigrations(pool, {
      through,
      exclude: [...EXCLUDED_MIGRATIONS],
      requireRoleBoundary: true,
    });
    migrations.push(...results.filter(item => item.status === 'applied').map(item => item.filename));
  }
  // Close the window on the same boundary the schema stage established: any
  // object the later migrations created is owned by the schema owner again and
  // has no default PUBLIC EXECUTE.
  await bootstrapRoles(pool, env);
  const record = {
    stage: 'data',
    applied: true,
    historicalized: historicalized.historicalized,
    confirmationId: historicalized.confirmationId,
    migrations,
    completedAt: new Date().toISOString(),
    workspaceId,
  };
  await writeJson(join(runDir, 'migration.json'), record);
  return { phase: 'migrate', ...record };
}

// ---------------------------------------------------------------------------
// verify: facts from the real rows, never from the report.
// ---------------------------------------------------------------------------

async function count(pool, sql, params = []) {
  const row = (await pool.query(sql, params)).rows[0];
  return Number(Object.values(row ?? {})[0] ?? 0);
}

async function verifyPhase({ pool, runDir, workspaceId }) {
  const migration = await readJson(join(runDir, 'migration.json'));
  if (migration.stage !== 'data' || migration.historicalized === undefined) {
    throw fail('migration-incomplete', 'the data stage of --phase migrate has not completed');
  }
  const migrationVersion = await liveSchemaMigrationVersion(pool);
  const bootstrap = await computeBootstrapFingerprint(pool);
  const roles = await verifyParallelShiftRoleBoundary(pool);
  const facts = {
    phase: 'verify',
    workspaceId,
    migrationVersion,
    bootstrap: { digest: bootstrap.digest, missing: bootstrap.missing },
    roleViolations: roles.violations,
    counts: {
      shifts: await count(pool, 'SELECT count(*) FROM shifts WHERE workspace_id = $1', [workspaceId]),
      historical: await count(pool, 'SELECT count(*) FROM shifts WHERE workspace_id = $1 AND historicalized_at IS NOT NULL', [workspaceId]),
      unresolvedRemaining: await count(pool, `SELECT count(*) FROM shifts
        WHERE workspace_id = $1 AND state = 'historical' AND payload_schema_version = 1
          AND (identity_resolution = 'unresolved' OR shift_type_resolution = 'unresolved')
          AND historicalized_at IS NULL`, [workspaceId]),
      statuses: await count(pool, 'SELECT count(*) FROM line_truck_statuses WHERE workspace_id = $1', [workspaceId]),
      logs: await count(pool, 'SELECT count(*) FROM line_logs WHERE workspace_id = $1', [workspaceId]),
      tabelRecords: await count(pool, 'SELECT count(*) FROM tabel_records WHERE workspace_id = $1', [workspaceId]),
      archiveSeries: await count(pool, 'SELECT count(*) FROM shift_archive_series WHERE workspace_id = $1', [workspaceId]),
      archiveRevisions: await count(pool, 'SELECT count(*) FROM shift_archive_revisions WHERE workspace_id = $1', [workspaceId]),
      replicaStream: await count(pool, 'SELECT count(*) FROM replica_stream WHERE workspace_id = $1', [workspaceId]),
      replicaHeads: await count(pool, 'SELECT count(*) FROM replica_document_heads WHERE workspace_id = $1', [workspaceId]),
      replicaPending: await count(pool, 'SELECT count(*) FROM replica_pending_documents WHERE workspace_id = $1', [workspaceId]),
      historicalizationAudit: await count(pool, 'SELECT count(*) FROM legacy_cutover_historicalization_audit WHERE workspace_id = $1', [workspaceId]),
      confirmations: await count(pool, 'SELECT count(*) FROM legacy_historicalization_confirmations WHERE workspace_id = $1', [workspaceId]),
    },
    invalidConstraints: (await pool.query('SELECT conname FROM pg_constraint WHERE NOT convalidated ORDER BY conname')).rows.map(row => row.conname),
    orphanPendingHeads: await count(pool, `SELECT count(*) FROM replica_document_heads h
      WHERE h.workspace_id = $1 AND h.head_kind = 'doc.set' AND h.canonical_present = false AND h.applied_seq IS NULL
        AND NOT EXISTS (SELECT 1 FROM replica_pending_documents p
          WHERE p.workspace_id = h.workspace_id AND p.collection = h.collection
            AND p.document_id = h.document_id AND p.stream_seq = h.head_seq)`, [workspaceId]),
    checkedAt: new Date().toISOString(),
  };
  if (facts.counts.unresolvedRemaining !== 0) throw fail('unresolved-legacy-remaining', `${facts.counts.unresolvedRemaining} unresolved legacy rows remain`, 1);
  if (facts.counts.historicalizationAudit !== migration.historicalized) {
    throw fail('historicalization-audit-mismatch', `audit ${facts.counts.historicalizationAudit} != confirmed ${migration.historicalized}`, 1);
  }
  if (facts.invalidConstraints.length > 0) throw fail('constraint-not-validated', facts.invalidConstraints.join(','), 1);
  if (facts.orphanPendingHeads !== 0) throw fail('replica-pending-orphan', `${facts.orphanPendingHeads} pending heads have no pending row`, 1);
  if (facts.roleViolations.length > 0) throw fail('role-boundary-violation', facts.roleViolations.join('; '), 1);
  if (facts.bootstrap.missing.relations.length > 0 || facts.bootstrap.missing.functions.length > 0) {
    throw fail('bootstrap-incomplete', 'required relations or functions are missing', 1);
  }
  await writeJson(join(runDir, 'verify.json'), facts);
  return facts;
}

async function reportPhase({ runDir }) {
  const backup = await readJson(join(runDir, 'backup', MANIFEST_FILE));
  const reportSha256 = (await readFile(join(runDir, 'report', 'report.sha256'), 'utf8')).trim().split(/\s+/)[0];
  const summary = {
    phase: 'report',
    backup: { sha256: backup.sha256, capturedAt: backup.capturedAt, tables: backup.tableCount, rows: backup.rowCount },
    report: { sha256: reportSha256 },
    confirmation: await readJson(join(runDir, 'confirmation.json')),
    migration: await readJson(join(runDir, 'migration.json')),
    verify: await readJson(join(runDir, 'verify.json')),
    completedAt: new Date().toISOString(),
  };
  await writeJson(join(runDir, 'summary.json'), summary);
  return {
    phase: 'report',
    backupSha256: summary.backup.sha256,
    reportSha256,
    confirmationId: summary.confirmation.confirmationId,
    historicalized: summary.migration.historicalized,
    migrationVersion: summary.verify.migrationVersion,
    counts: summary.verify.counts,
  };
}

const phaseRunners = {
  backup: backupPhase,
  preflight: preflightPhase,
  confirm: confirmPhase,
  migrate: migratePhase,
  verify: verifyPhase,
  report: reportPhase,
};

/**
 * Run one phase. `overrides.pool` lets a rehearsal inject a privileged
 * connection; the CLI builds its own from the environment. Unknown extra keys
 * (restore/deploy/publish spies) are never called: those names are refused
 * before the deps are even built.
 */
export async function runMaintenance(options, overrides = {}) {
  const phase = options.phase;
  if (OUT_OF_SCOPE_PHASES[phase]) {
    throw fail('out-of-scope', OUT_OF_SCOPE_PHASES[phase]);
  }
  if (!PHASES.includes(phase)) throw fail('usage', `--phase must be one of ${PHASES.join(', ')}`);
  const env = options.env ?? process.env;
  if (options.dryRun !== false) {
    // Preview is honest but harmless: it names every prerequisite and lists the
    // ones that are absent instead of failing, so an operator can read the whole
    // plan before running the earlier phases. Strictness lives in `--apply`.
    const required = phasePreconditions(phase, options);
    const missing = [];
    for (const path of required) if (!(await exists(path))) missing.push(path);
    return {
      phase,
      dryRun: true,
      plan: ['validate target', ...required.map(path => `require ${path}`), `apply ${phase}`],
      missing,
    };
  }
  await checkPreconditions(phase, options);
  assertIsolatedTarget(env);
  const pool = overrides.pool ?? buildPool({ ...env, TEST_DATABASE_URL: privilegedUrl(env) });
  const ownsPool = !overrides.pool;
  try {
    return await phaseRunners[phase]({ ...options, env, pool });
  } finally {
    if (ownsPool) await pool.end();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_OPTIONS = new Map([
  ['--phase', 'phase'],
  ['--run-dir', 'runDir'],
  ['--report-dir', 'reportDir'],
  ['--report-sha256', 'reportSha256'],
  ['--expires-at', 'expiresAt'],
  ['--workspace', 'workspaceId'],
  ['--owner-uid', 'ownerActorUid'],
  ['--confirmation-id', 'confirmationId'],
  ['--maintenance-uid', 'maintenanceActorUid'],
]);

export function parseArgs(argv) {
  const options = { dryRun: true, workspaceId: process.env.WORKSPACE_ID || 'main_workspace' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.dryRun = false;
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    // `--yes` and `--force` do not exist on purpose: the only confirmation is
    // the exact report bytes/hash.
    if (argument === '--yes' || argument === '--force' || argument.startsWith('--yes=') || argument.startsWith('--force=')) {
      throw fail('forbidden-flag', `${argument.split('=')[0]} is not supported; confirmation is the exact report hash`);
    }
    const key = VALUE_OPTIONS.get(argument);
    if (!key) throw fail('usage', `unknown option ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw fail('usage', `${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  if (!options.phase) throw fail('usage', `--phase is required (${PHASES.join(', ')})`);
  return options;
}

function describeError(error) {
  if (error.maintenance === true) return { code: error.code, message: error.message };
  // A PostgreSQL error message can carry row values. Report only the stable
  // identity of the failure, never the message or detail.
  return {
    code: 'database-error',
    sqlstate: typeof error.code === 'string' ? error.code : null,
    constraint: error.constraint ?? null,
    table: error.table ?? null,
  };
}

function usage() {
  return [
    'usage: maintenance-parallel-shifts.mjs --phase <name> --run-dir <dir> [--apply]',
    `phases: ${PHASES.join(', ')}`,
    'refused: deploy, publish, restore (manual, by the runbook)',
    'confirm: --report-sha256 <hex> [--report-dir <dir>] --owner-uid <uid> --confirmation-id <id>',
    'preflight: --expires-at <iso>',
    'migrate (data stage): --maintenance-uid <uid>',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.dryRun) {
    const result = await runMaintenance(options);
    console.log(JSON.stringify(result));
    return 0;
  }
  const result = await runMaintenance(options);
  console.log(JSON.stringify(result));
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    const described = describeError(error);
    console.error(`maintenance: ${described.code} ${described.message ?? JSON.stringify(described)}`);
    if (error.code === 'usage') console.error(usage());
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  });
}
