import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

import {
  adminUrl,
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
  seedParallelShiftFixture,
} from './helpers/isolated-db.mjs';
import {
  assertIsolatedTarget,
  canonicalJson,
  parseArgs,
  runMaintenance,
} from '../scripts/maintenance-parallel-shifts.mjs';
import { bundleFacts, normalizeBackupSelection, verifyBundleManifest } from '../src/backup-store.mjs';
import { maintenanceDecision, protocolDecision } from '../src/service-gate.mjs';

// Rehearsal of the maintenance window on the disposable copy the harness clones
// for this root. Every number below comes from the rows the test itself created:
// the report hash, the historicalized count and the audit rows are compared with
// each other, never with a hardcoded expectation.
const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try { requireIsolatedDatabase(connectionString); approved = true; } catch {}
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const skip = approved ? false : 'needs the isolated cluster on 55432';

function adminPool(max = 2) {
  return new pg.Pool({ connectionString: adminUrl().href, max });
}

async function tableHash(pool, table, workspaceId) {
  const rows = (await pool.query(`SELECT * FROM ${table} WHERE workspace_id = $1`, [workspaceId])).rows;
  return sha256(canonicalJson(JSON.parse(JSON.stringify(rows))));
}

// The rehearsal refuses a shared target exactly like the harness helper does.
test('the isolation gate matches the harness rule', () => {
  const env = url => ({ SAMOSVAL_ISOLATED_TEST: '1', TEST_DATABASE_URL: url });
  for (const url of [
    'postgresql://u:p@127.0.0.1:55432/samosval_parallel_shifts_test',
    'postgresql://u:p@localhost:55432/samosval_parallel_shifts_test_0123456789ab_0123456789ab',
  ]) {
    assert.equal(assertIsolatedTarget(env(url)), url);
  }
  assert.throws(() => assertIsolatedTarget({ TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:55432/samosval_parallel_shifts_test' }),
    { code: 'isolated-test-required' });
  for (const url of [
    'postgresql://u:p@127.0.0.1:55432/main_workspace',
    'postgresql://u:p@db.internal:5432/samosval_parallel_shifts_test',
    'postgresql://u:p@127.0.0.1:55432/samosval_parallel_shifts_test?sslmode=require',
    'postgresql://u:p@127.0.0.1:55432/samosval_parallel_shifts_test_zzzz_0123456789ab',
  ]) {
    assert.throws(() => assertIsolatedTarget(env(url)), { code: 'isolated-database-required' }, url);
  }
});

// Deploy/publish/restore are refused before the pool is even built: the spy
// proves the script cannot reach a database through those names.
test('out-of-scope phases never touch the injected pool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'samosval-maint-spy-'));
  const calls = [];
  const spy = { query: async (...args) => { calls.push(args); throw new Error('must not be called'); }, end: async () => {} };
  try {
    for (const phase of ['deploy', 'publish', 'restore']) {
      await assert.rejects(
        () => runMaintenance({ phase, runDir: directory, dryRun: false, workspaceId: 'ws' }, { pool: spy }),
        { code: 'out-of-scope' },
      );
    }
    // Dry-run plans the phase and stops: no query, no file.
    const planned = await runMaintenance({ phase: 'backup', runDir: directory, dryRun: true, workspaceId: 'ws' }, { pool: spy });
    assert.equal(planned.dryRun, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the service gate answers 426 only for the eight legacy shift routes', () => {
  const v2 = { SAMOSVAL_V2_SHIFTS: '1' };
  const routes = [
    ['/api/v1/shifts/start', 'POST'], ['/api/v1/shifts/close', 'POST'],
    ['/api/v1/line/snapshot', 'GET'], ['/api/v1/line/operations', 'POST'],
    ['/api/v1/report/operations', 'POST'], ['/api/v1/history', 'GET'],
    ['/api/v1/history', 'POST'], ['/api/v1/archive/operations', 'POST'],
    ['/api/v1/controls', 'POST'],
  ];
  for (const [path, method] of routes) {
    assert.deepEqual(protocolDecision({ path, method, env: v2 }), {
      status: 426, body: { error: 'protocol-upgrade-required', protocolVersion: 2 },
    }, `${method} ${path}`);
  }
  // Workspace-wide catalog/archive/tabel reads keep working: there is no v2
  // replacement for them, so a 426 would make the data unreachable.
  for (const [path, method] of [
    ['/api/v1/archive/snapshot', 'GET'], ['/api/v1/catalog', 'GET'],
    ['/api/v1/tabel/records', 'GET'], ['/api/v1/tabel/presence', 'GET'],
    ['/api/v1/backups', 'POST'],
  ]) {
    assert.equal(protocolDecision({ path, method, env: v2 }), null, `${method} ${path}`);
  }
  // During the window every API route is closed, backups included: the verified
  // backup is therefore taken by this script directly in the database.
  assert.equal(maintenanceDecision({ path: '/api/v1/backups', method: 'POST', env: { SAMOSVAL_MAINTENANCE: '1' } }).status, 503);
  assert.equal(maintenanceDecision({ path: '/health/ready', method: 'GET', env: { SAMOSVAL_MAINTENANCE: '1' } }), null);
});

test('the CLI parser refuses confirmation shortcuts and unknown options', () => {
  for (const argv of [['--phase', 'backup', '--yes'], ['--phase', 'backup', '--force'], ['--phase', 'backup', '--dsn', 'x']]) {
    assert.throws(() => parseArgs(argv), error => error.code === 'forbidden-flag' || error.code === 'usage');
  }
  const parsed = parseArgs(['--phase', 'confirm', '--run-dir', '/tmp/x', '--report-sha256', 'a'.repeat(64)]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.reportSha256, 'a'.repeat(64));
});

test('full maintenance rehearsal: backup, exact report, migration, verify', { skip }, async () => {
  const pool = adminPool();
  const runDir = await mkdtemp(join(tmpdir(), 'samosval-maint-run-'));
  const ids = { workspaceId: 'workspace_maint_rehearsal' };
  try {
    // ---------- fixture: legacy v1 rows must exist BEFORE 025 ----------
    await resetIsolatedDatabase();
    await applyMigrationsThrough(24);
    const seeded = await seedParallelShiftFixture({ suffix: 'maint', workspaceId: ids.workspaceId });
    const fixture = new pg.Pool({ connectionString, max: 1 });
    try {
      // Three unresolved combinations: source/unresolved, unresolved/source and
      // unresolved/unresolved. Each is a real legacy row, not an inferred type.
      const legacy = [
        {
          shiftId: 'legacy_identity_source', objectId: seeded.objectAId,
          payload: {
            id: 'legacy_identity_source', objectId: seeded.objectAId, objectName: seeded.objectAId,
            startDate: '23.11.2026', startedAt: 1795420800000, startedBy: 'legacy',
            startedByUid: seeded.adminUid, isActive: false,
          },
          statuses: [{ truckId: 'legacy_truck_a', payload: { id: 'legacy_truck_a', shiftId: 'legacy_identity_source', onLine: true, arriveTimestamp: 1795420800000, ttnStatus: null, cycleRevision: 1, ttnRevision: 1 } }],
          logs: [],
        },
        {
          shiftId: 'legacy_type_source', objectId: seeded.objectAId,
          payload: {
            id: 'legacy_type_source', objectId: seeded.objectAId, objectName: seeded.objectAId,
            startDate: '23.11.2026', startedAt: 1795421000000, startedBy: 'legacy',
            isActive: false, workShift: 'day',
          },
          statuses: [],
          logs: [{ logId: 'legacy_log_1', payload: { id: 'legacy_log_1', type: 'load', timestamp: 1795421010000 } }],
        },
        {
          shiftId: 'legacy_both_unresolved', objectId: seeded.objectBId,
          payload: {
            id: 'legacy_both_unresolved', objectId: seeded.objectBId, objectName: seeded.objectBId,
            startDate: '23.11.2026', startedAt: 1795421200000, startedBy: 'legacy',
            isActive: false,
          },
          statuses: [],
          logs: [],
        },
      ];
      for (const row of legacy) {
        await fixture.query(
          'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)',
          [ids.workspaceId, row.shiftId, row.payload],
        );
        for (const status of row.statuses) {
          await fixture.query(
            'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [ids.workspaceId, status.truckId, { id: status.truckId, name: status.truckId }],
          );
          await fixture.query(
            'INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)',
            [ids.workspaceId, status.truckId, row.shiftId, status.payload],
          );
        }
        for (const log of row.logs) {
          await fixture.query(
            'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [ids.workspaceId, 'legacy_truck_b', { id: 'legacy_truck_b', name: 'legacy_truck_b' }],
          );
          await fixture.query(
            'INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
            [ids.workspaceId, log.logId, row.shiftId, 'legacy_truck_b', log.payload],
          );
        }
      }
      // Legacy v1 replica history with a contiguous native prefix, plus a tabel
      // row: the rehearsal must survive real pre-026 transport state.
      for (const seq of [1, 2]) {
        await fixture.query(
          `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256)
           VALUES($1,$2,'f2s',$3,'doc.set',$4,$5)`,
          [ids.workspaceId, seq, `legacy-op-000${seq}`, { collection: 'shift', path: `shift_${seq}`, data: { id: `shift_${seq}` } }, sha256(`legacy-op-000${seq}`)],
        );
      }
      await fixture.query(
        'INSERT INTO replica_cursor(workspace_id,f2s_seq,s2f_seq) VALUES($1,2,0)',
        [ids.workspaceId],
      );
      await fixture.query(
        'INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload) VALUES($1,$2,$3,$4,$5)',
        [ids.workspaceId, 'tabel_maint_1', seeded.objectAId, 'tabel_maint_1', { date: '20.11.2026', hours: 8 }],
      );
    } finally {
      await fixture.end();
    }

    // ---------- phase backup on the pre-025 schema ----------
    const backup = await runMaintenance({ phase: 'backup', runDir, dryRun: false, workspaceId: ids.workspaceId });
    assert.equal(backup.phase, 'backup');
    assert.match(backup.sha256, HEX64);
    assert.equal(backup.exactBundle.status, 'skipped', 'no 026 schema yet, so no exact bundle');
    const manifest = JSON.parse(await readFile(join(runDir, 'backup', 'manifest.json'), 'utf8'));
    assert.equal(manifest.sha256, backup.sha256);
    assert.match(manifest.databaseFingerprint, HEX64);
    const snapshotBytes = await readFile(join(runDir, 'backup', 'snapshot.json'));
    assert.equal(sha256(snapshotBytes), manifest.sha256, 'the manifest names the exact snapshot bytes');
    const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
    assert.ok(snapshot.tables.shifts.count >= 5);
    assert.ok(snapshot.tables.replica_stream.count >= 2);
    assert.equal(snapshot.tables.tabel_records.count, 1);

    // ---------- preflight refuses before 025 ----------
    await assert.rejects(
      () => runMaintenance({ phase: 'preflight', runDir, dryRun: false, workspaceId: ids.workspaceId, expiresAt: '2099-01-01T00:00:00.000Z' }),
      { code: 'schema-not-ready' },
    );

    // ---------- schema stage of migrate: role split + 025 ----------
    const schemaStage = await runMaintenance({ phase: 'migrate', runDir, dryRun: false, workspaceId: ids.workspaceId });
    assert.equal(schemaStage.stage, 'schema');
    assert.equal(schemaStage.historicalized, 0);
    const applied = new Set((await pool.query('SELECT filename FROM schema_migrations')).rows.map(row => row.filename));
    assert.ok(applied.has('025_parallel_shifts_core.sql'));
    assert.ok(!applied.has('026_parallel_shift_dependencies.sql'));

    // ---------- preflight: read-only exact report ----------
    const beforeShifts = await tableHash(pool, 'shifts', ids.workspaceId);
    const beforeStatuses = await tableHash(pool, 'line_truck_statuses', ids.workspaceId);
    const preflight = await runMaintenance({
      phase: 'preflight', runDir, dryRun: false, workspaceId: ids.workspaceId,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(preflight.written, true);
    const reportBytes = await readFile(join(runDir, 'report', 'report.json'));
    assert.equal(sha256(reportBytes), preflight.sha256);
    assert.equal((await readFile(join(runDir, 'report', 'report.sha256'), 'utf8')).trim().split(/\s+/)[0], preflight.sha256);
    const report = JSON.parse(reportBytes.toString('utf8'));
    assert.equal(report.schema, 'samosval.legacy-historicalization/v1');
    assert.equal(report.backupManifestSha256, manifest.sha256, 'the report is bound to the verified backup');
    assert.equal(report.databaseFingerprint, manifest.databaseFingerprint);
    // The rows come from the live table, not from a hardcoded list.
    const scoped = (await pool.query(
      `SELECT shift_id FROM shifts WHERE workspace_id = $1 AND state = 'historical'
         AND payload_schema_version = 1
         AND (identity_resolution = 'unresolved' OR shift_type_resolution = 'unresolved')
         AND historicalized_at IS NULL ORDER BY shift_id`,
      [ids.workspaceId],
    )).rows.map(row => row.shift_id);
    assert.deepEqual(report.rows.map(row => row.shiftId), scoped);
    assert.ok(scoped.includes('legacy_both_unresolved'));
    const reportText = await readFile(join(runDir, 'report', 'report.txt'), 'utf8');
    assert.ok(reportText.includes(preflight.sha256));
    assert.ok(!reportText.includes(ids.workspaceId), 'the human summary carries no workspace identifier');
    assert.equal(await tableHash(pool, 'shifts', ids.workspaceId), beforeShifts, 'preflight must not mutate shifts');
    assert.equal(await tableHash(pool, 'line_truck_statuses', ids.workspaceId), beforeStatuses, 'preflight must not mutate statuses');
    assert.equal(Number((await pool.query('SELECT count(*) FROM legacy_historicalization_confirmations')).rows[0].count), 0);

    // ---------- confirm: a wrong hash or a changed row list is refused ----------
    await assert.rejects(
      () => runMaintenance({
        phase: 'confirm', runDir, dryRun: false, workspaceId: ids.workspaceId,
        reportSha256: '0'.repeat(64), ownerActorUid: seeded.adminUid, confirmationId: 'conf_maint_wrong',
      }),
      { code: 'report-hash-mismatch' },
    );
    assert.equal(Number((await pool.query('SELECT count(*) FROM legacy_historicalization_confirmations')).rows[0].count), 0);

    // A row added to the report changes the bytes. With a matching new hash the
    // confirmation is accepted (the owner confirms bytes), but the cutover must
    // then refuse: the live rows do not rebuild those bytes.
    const tamperedReport = JSON.parse(reportBytes.toString('utf8'));
    tamperedReport.rows.push({ ...tamperedReport.rows[0], shiftId: 'legacy_invented_row' });
    const tamperedBytes = Buffer.from(canonicalJson(tamperedReport), 'utf8');
    await writeFile(join(runDir, 'report', 'report.json'), tamperedBytes);
    await writeFile(join(runDir, 'report', 'report.sha256'), `${sha256(tamperedBytes)}  report.json\n`);
    await runMaintenance({
      phase: 'confirm', runDir, dryRun: false, workspaceId: ids.workspaceId,
      reportSha256: sha256(tamperedBytes), ownerActorUid: seeded.adminUid, confirmationId: 'conf_maint_tampered',
    });
    await assert.rejects(
      () => runMaintenance({ phase: 'migrate', runDir, dryRun: false, workspaceId: ids.workspaceId, maintenanceActorUid: seeded.adminUid }),
      { code: 'report-bytes-changed' },
    );
    assert.equal(Number((await pool.query('SELECT count(*) FROM legacy_cutover_historicalization_audit')).rows[0].count), 0, 'no audit row after a refused cutover');
    assert.equal(await tableHash(pool, 'shifts', ids.workspaceId), beforeShifts, 'the refused cutover left shifts untouched');

    // ---------- confirm with the exact original bytes ----------
    await writeFile(join(runDir, 'report', 'report.json'), reportBytes);
    await writeFile(join(runDir, 'report', 'report.sha256'), `${preflight.sha256}  report.json\n`);
    const confirmed = await runMaintenance({
      phase: 'confirm', runDir, dryRun: false, workspaceId: ids.workspaceId,
      reportSha256: preflight.sha256, ownerActorUid: seeded.adminUid, confirmationId: 'conf_maint_real',
    });
    assert.equal(confirmed.rowCount, scoped.length);
    const stored = (await pool.query(
      'SELECT report_sha256, row_count, state FROM legacy_historicalization_confirmations WHERE confirmation_id = $1',
      ['conf_maint_real'],
    )).rows[0];
    assert.equal(stored.report_sha256, preflight.sha256);
    assert.equal(Number(stored.row_count), scoped.length);
    assert.equal(stored.state, 'pending');

    // ---------- data stage: exact historicalization + 026 + 027 ----------
    const dataStage = await runMaintenance({ phase: 'migrate', runDir, dryRun: false, workspaceId: ids.workspaceId, maintenanceActorUid: seeded.adminUid });
    assert.equal(dataStage.stage, 'data');
    assert.equal(dataStage.historicalized, scoped.length);
    assert.equal(dataStage.confirmationId, 'conf_maint_real');
    const appliedAfter = new Set((await pool.query('SELECT filename FROM schema_migrations')).rows.map(row => row.filename));
    for (const migration of ['026_parallel_shift_dependencies.sql', '027_parallel_shift_permissions.sql']) {
      assert.ok(appliedAfter.has(migration), migration);
    }
    const historicalized = (await pool.query(
      'SELECT shift_id FROM shifts WHERE workspace_id = $1 AND historicalized_at IS NOT NULL ORDER BY shift_id',
      [ids.workspaceId],
    )).rows.map(row => row.shift_id);
    assert.deepEqual(historicalized, scoped, 'exactly the confirmed rows were historicalized');
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM legacy_cutover_historicalization_audit WHERE workspace_id = $1', [ids.workspaceId],
    )).rows[0].count), scoped.length);
    // Current assignments of the historicalized rows are released, snapshots kept.
    const released = Number((await pool.query(
      `SELECT count(*) FROM line_truck_statuses WHERE workspace_id = $1 AND shift_id = ANY($2::text[])`,
      [ids.workspaceId, scoped],
    )).rows[0].count);
    assert.equal(released, 0);
    assert.ok(Number((await pool.query(
      'SELECT count(*) FROM legacy_line_status_snapshots WHERE workspace_id = $1', [ids.workspaceId],
    )).rows[0].count) > 0);
    // 026 is applied, so the transport tables exist and are queryable.
    assert.equal(Number((await pool.query('SELECT count(*) FROM replica_document_heads WHERE workspace_id = $1', [ids.workspaceId])).rows[0].count), 0);

    // ---------- backup again: the exact provenance bundle is now available ----------
    const secondBackup = await runMaintenance({ phase: 'backup', runDir, dryRun: false, workspaceId: ids.workspaceId });
    assert.equal(secondBackup.reused, true, 'the first snapshot hash is never rewritten');
    assert.equal(secondBackup.sha256, backup.sha256);
    assert.equal(secondBackup.exactBundle.status, 'verified');
    const bundleBytes = await readFile(join(runDir, 'backup', 'exact-bundle.json'), 'utf8');
    assert.equal(sha256(Buffer.from(bundleBytes)), secondBackup.exactBundle.sha256);
    assert.equal(
      (await readFile(join(runDir, 'backup', 'exact-bundle.sha256'), 'utf8')).trim().split(/\s+/)[0],
      secondBackup.exactBundle.sha256,
    );
    const bundle = JSON.parse(bundleBytes, (key, value) => (
      value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)
        ? Buffer.from(value.data)
        : value
    ));
    assert.equal(verifyBundleManifest(bundle), true);
    const verified = JSON.parse(await readFile(join(runDir, 'backup', 'exact-bundle.verified.json'), 'utf8'));
    assert.equal(verified.digest, bundle.manifest.digest);

    // ---------- verify: facts from the real rows ----------
    const verifiedReport = await runMaintenance({ phase: 'verify', runDir, dryRun: false, workspaceId: ids.workspaceId });
    assert.equal(verifiedReport.counts.historical, scoped.length);
    assert.equal(verifiedReport.counts.unresolvedRemaining, 0);
    assert.equal(verifiedReport.counts.historicalizationAudit, scoped.length);
    assert.equal(verifiedReport.counts.confirmations, 2, 'one tampered confirmation and one real one are stored');
    assert.deepEqual(verifiedReport.roleViolations, []);
    assert.deepEqual(verifiedReport.bootstrap.missing, { relations: [], functions: [] });
    assert.deepEqual(verifiedReport.invalidConstraints, []);
    assert.equal(verifiedReport.counts.replicaStream, 2);
    assert.equal(verifiedReport.counts.tabelRecords, 1);
    assert.equal(verifiedReport.migrationVersion, '027_parallel_shift_permissions.sql');

    // ---------- report: the summary carries hashes and counts, never a DSN ----------
    const summary = await runMaintenance({ phase: 'report', runDir, dryRun: false, workspaceId: ids.workspaceId });
    assert.equal(summary.backupSha256, backup.sha256);
    assert.equal(summary.reportSha256, preflight.sha256);
    assert.equal(summary.historicalized, scoped.length);
    const summaryText = await readFile(join(runDir, 'summary.json'), 'utf8');
    assert.ok(!summaryText.includes('postgresql://'), 'no connection string in the summary');
    assert.ok(!summaryText.includes(seeded.adminUid), 'no actor uid in the summary');

    // ---------- selective restore is rejected before any mutation ----------
    const facts = bundleFacts(bundle);
    assert.equal(facts.historical.rows, scoped.length);
    assert.equal(facts.historical.closure, true);
    assert.throws(() => normalizeBackupSelection({ replica: true }, facts), { code: 'backup-selection-provenance-not-selectable' });
    assert.throws(() => normalizeBackupSelection({ base: true }, facts), { code: 'backup-selection-replica-required' });
    assert.deepEqual(normalizeBackupSelection({ full: true }, facts), {
      full: true,
      sections: { base: true, archive: true, shift: true, settings: true, users: true, tabel: true },
    });
    // Nothing in the rehearsal calls restore: the bundle is an artifact, and a
    // restore of the shared database is a separate destructive approval.
    const restoreCalls = [];
    await assert.rejects(
      () => runMaintenance({ phase: 'restore', runDir, dryRun: false, workspaceId: ids.workspaceId },
        { pool: { query: async (...args) => { restoreCalls.push(args); }, end: async () => {} } }),
      { code: 'out-of-scope' },
    );
    assert.deepEqual(restoreCalls, []);
  } finally {
    await pool.end().catch(() => {});
    await rm(runDir, { recursive: true, force: true });
  }
});
