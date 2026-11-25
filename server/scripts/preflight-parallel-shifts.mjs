#!/usr/bin/env node
// Read-only preflight for legacy historicalization (Task 4).
// Builds the exact report and writes report.json / report.sha256 / report.txt.
// There is intentionally NO mutation mode: confirmation is recorded only from the
// exact bytes/hash by the maintenance entrypoint, never from flags or env.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPool } from './apply-migrations.mjs';
import {
  buildHistoricalizationReport,
  computeDatabaseFingerprint,
  CONSEQUENCES,
} from '../src/legacy-historicalization.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg === '--apply' || arg.startsWith('--apply='))) {
  console.error('preflight: --apply does not exist; this command is read-only');
  process.exit(2);
}
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
if (!outDir) {
  console.error('usage: preflight-parallel-shifts.mjs --out <dir> [--workspace <id>] [--expires-at <iso>] [--backup-manifest-sha256 <hex>] [--database-fingerprint <text>]');
  process.exit(2);
}
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const workspaceId = option('--workspace') || process.env.WORKSPACE_ID || 'main_workspace';
const expiresAt = option('--expires-at');
const backupManifestSha256 = option('--backup-manifest-sha256');
const databaseFingerprint = option('--database-fingerprint');
if (!expiresAt || !backupManifestSha256 || !databaseFingerprint) {
  console.error('preflight: --expires-at, --backup-manifest-sha256 and --database-fingerprint are required');
  process.exit(2);
}

const pool = buildPool();
const client = await pool.connect();
try {
  // Read-only transaction: any accidental write fails at the database level.
  await client.query('BEGIN READ ONLY');
  const migrationVersion = (await client.query("SELECT max(filename) AS v FROM schema_migrations")).rows[0]?.v ?? null;
  // The owner confirms the environment by passing the fingerprint. Verify it against
  // the live cluster instead of trusting the flag: a stale or copied value would
  // otherwise be stored in the report and later compared only with itself.
  const liveFingerprint = await computeDatabaseFingerprint(client);
  if (liveFingerprint !== databaseFingerprint) {
    const error = Object.assign(new Error('confirmation-environment-changed'), { code: 'confirmation-environment-changed' });
    throw error;
  }
  const built = await buildHistoricalizationReport(client, {
    workspaceId,
    migrationVersion,
    generatedAt: new Date().toISOString(),
    expiresAt,
    backupManifestSha256,
    databaseFingerprint: liveFingerprint,
  });
  await client.query('COMMIT');

  // D8: an empty list is a successful no-op; nothing is written.
  if (built.rowCount === 0) {
    console.log('rows=0: no legacy rows need historicalization; nothing written');
    process.exitCode = 0;
  } else {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'report.json'), built.bytes);
    await writeFile(join(outDir, 'report.sha256'), `${built.sha256}  report.json\n`);
    const lines = [
      `Отчёт историзации legacy-смен. Количество строк: ${built.rowCount}`,
      `SHA-256: ${built.sha256}`,
      `Срок действия: ${expiresAt}`,
      `Отпечаток БД: ${liveFingerprint}`,
      ...CONSEQUENCES,
    ];
    await writeFile(join(outDir, 'report.txt'), `${lines.join('\n')}\n`);
    console.log(`rows=${built.rowCount} sha256=${built.sha256}`);
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`preflight: ${error.code ?? 'error'} ${error.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
