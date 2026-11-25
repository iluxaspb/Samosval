import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  UNFINISHED_CYCLE_RULE_ID,
  isUnfinishedCycle,
  buildHistoricalizationReport,
  recordHistoricalizationConfirmation,
  historicalizeConfirmedLegacy,
  canonicalJson,
  REPORT_SCHEMA,
} from '../src/legacy-historicalization.mjs';
import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
  seedParallelShiftFixture,
} from './helpers/isolated-db.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try { requireIsolatedDatabase(connectionString); approved = true; } catch {}
}
const db = (max = 1) => new pg.Pool({ connectionString, max });
const sha = s => createHash('sha256').update(s).digest('hex');
const FP = 'fp-test-1';
const MANIFEST = sha('backup-manifest-test');
const FUTURE = '2099-01-01T00:00:00.000Z';

// ---------- pure predicate and canonical JSON (no DB) ----------

test('unfinished-cycle rule is explicit, versioned and exported', () => {
  assert.equal(UNFINISHED_CYCLE_RULE_ID, 'unfinished-cycle-v1');
});

test('off-line truck never has an unfinished cycle', () => {
  assert.equal(isUnfinishedCycle({ onLine: false, arriveTimestamp: 1, ttnStatus: null }), false);
});

test('arrival or load without ttn collection is an unfinished cycle', () => {
  assert.equal(isUnfinishedCycle({ onLine: true, arriveTimestamp: 1700000000000, ttnStatus: null }), true);
  assert.equal(isUnfinishedCycle({ onLine: true, lastLoadTimestamp: 1700000000000, ttnStatus: 'pending' }), true);
});

test('collected ttn closes the cycle', () => {
  assert.equal(isUnfinishedCycle({ onLine: true, arriveTimestamp: 1700000000000, ttnStatus: true }), false);
});

test('on-line truck without any cycle timestamp has no unfinished cycle', () => {
  assert.equal(isUnfinishedCycle({ onLine: true, arriveTimestamp: null, lastLoadTimestamp: null, ttnStatus: null }), false);
});

test('canonical JSON sorts keys and has no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
});

test('canonical JSON rejects non-finite numbers', () => {
  assert.throws(() => canonicalJson({ n: Number.NaN }), { code: 'canonical-non-finite-number' });
});

// ---------- DB behaviour (needs the one-off isolated cluster on 55432) ----------

// Legacy v1 rows must exist BEFORE 025: the P3 trigger rejects a v1 INSERT after it.
// 025 then classifies them (unresolved type -> historical), as in production.
async function prepare(suffix, legacyRows = []) {
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
  const ids = await seedParallelShiftFixture({ suffix });
  const seed = db();
  try {
    for (const row of legacyRows) await seedLegacyV1(seed, ids, row);
  } finally { await seed.end(); }
  await applyMigrationsThrough(25);
  return ids;
}

async function seedLegacyV1(pool, ids, { shiftId, withStatus = true }) {
  const payload = {
    id: shiftId, objectId: ids.objectAId, objectName: ids.objectAId,
    startDate: '23.11.2026', startedAt: 1795420800000, startedBy: 'legacy', isActive: false,
    closing: true, closingStartedAt: 1795420900000, closingBy: 'legacy', state: 'closing',
  };
  await pool.query(
    'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)',
    [ids.workspaceId, shiftId, payload],
  );
  if (withStatus) {
    await pool.query(
      'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
      [ids.workspaceId, `${shiftId}_truck`, { id: `${shiftId}_truck`, name: `${shiftId}_truck` }],
    );
    await pool.query(
      'INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)',
      [ids.workspaceId, `${shiftId}_truck`, shiftId,
        { id: `${shiftId}_truck`, shiftId, onLine: true, arriveTimestamp: 1795420800000, ttnStatus: null, cycleRevision: 1, ttnRevision: 1 }],
    );
  }
}

function buildFor(client, ids, expiresAt = FUTURE) {
  return buildHistoricalizationReport(client, {
    workspaceId: ids.workspaceId,
    migrationVersion: '025_parallel_shifts_core.sql',
    generatedAt: '2026-11-25T00:00:00.000Z',
    expiresAt,
    backupManifestSha256: MANIFEST,
    databaseFingerprint: FP,
  });
}

function confirm(client, ids, built, confirmationId, expiresAt = FUTURE) {
  return recordHistoricalizationConfirmation(client, {
    confirmationId, reportBytes: built.bytes, reportSha256: built.sha256,
    ownerActorUid: ids.adminUid, expiresAt, backupManifestSha256: MANIFEST, databaseFingerprint: FP,
  });
}

test('report is exact, schema-tagged, sorted and free of close values or PII', { skip: !approved }, async () => {
  const ids = await prepare('report_exact', [
    { shiftId: 'shift_z_report' },
    { shiftId: 'shift_a_report', withStatus: false },
  ]);
  const pool = db();
  const client = await pool.connect();
  try {
    const a = await buildFor(client, ids);
    const b = await buildFor(client, ids);
    assert.equal(a.sha256, b.sha256, 'rebuilding from the same rows must give the same bytes');
    assert.equal(a.report.schema, REPORT_SCHEMA);
    assert.deepEqual(a.report.rows.map(r => r.shiftId), ['shift_a_report', 'shift_z_report']);
    assert.equal(a.rowCount, 2);
    const row = a.report.rows.find(r => r.shiftId === 'shift_z_report');
    assert.equal(row.assignmentSummary.currentAssignmentCount, 1);
    assert.equal(row.assignmentSummary.unfinishedCycleCount, 1);
    assert.equal(row.assignmentSummary.statusSnapshotsToCreate, 1);
    assert.deepEqual(Object.keys(row.assignmentSummary.currentStatusFieldCounts).sort(),
      ['arriveTimestampPresent', 'lastLoadTimestampPresent', 'loadedAfterArriveTrue',
        'onLineTrue', 'ttnStatusCollected', 'ttnStatusPending']);
    const text = a.bytes.toString('utf8');
    assert.equal(text.includes(`"objectId":"${ids.objectAId}"`), true);
    assert.equal(text.includes('"legacy"'), false, 'close actor value never appears, only presence/hash');
    assert.equal(text.includes(ids.adminUid), false, 'actor uids are not emitted');
    assert.equal(text.includes('shift_z_report_truck'), false, 'truck ids are not emitted (no safeTruckIds policy)');
    assert.equal(a.report.consequences.length, 2);
    assert.deepEqual(a.report.consequences, [
      'Текущие назначения этих самосвалов будут освобождены',
      'Незавершённая работа будет сохранена как неизменяемый исторический снимок и не будет считаться завершённой',
    ]);
    // Byte-exactness: any changed key order, count or consequence text changes this hash.
    assert.equal(a.sha256, '6ea9e539863b804def35c5d1b710f26a36230ed4a1f3a53b689d29c5d4c7630f');
    assert.equal(Object.hasOwn(a.report.rows[0].assignmentSummary, 'safeTruckIds'), false);
  } finally { client.release(); await pool.end(); }
});

test('a tampered stored report aborts with no data mutation', { skip: !approved }, async () => {
  const ids = await prepare('byte_change', [{ shiftId: 'shift_byte' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_byte');
    const tampered = Buffer.from(built.bytes);
    tampered[tampered.length - 2] ^= 0x01;
    await client.query(
      "UPDATE legacy_historicalization_confirmations SET report_bytes=$2, report_sha256=encode(sha256($2),'hex') WHERE confirmation_id=$1",
      ['conf_byte', tampered],
    );
    await assert.rejects(
      () => historicalizeConfirmedLegacy(client, { confirmationId: 'conf_byte', confirmReportSha256: built.sha256, maintenanceActorUid: ids.adminUid }),
      { code: 'report-hash-mismatch' },
    );
    assert.equal((await client.query("SELECT state FROM shifts WHERE shift_id='shift_byte'")).rows[0].state, 'historical');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_line_status_snapshots')).rows[0].n, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM line_truck_statuses')).rows[0].n, 1);
    assert.equal((await client.query("SELECT state FROM legacy_historicalization_confirmations WHERE confirmation_id='conf_byte'")).rows[0].state, 'pending');
  } finally { client.release(); await pool.end(); }
});

test('a source change after confirmation aborts byte-for-byte with no mutation', { skip: !approved }, async () => {
  const ids = await prepare('source_change', [{ shiftId: 'shift_src' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_src');
    // Same shift set, different assignment state: the rebuild must not match the confirmed bytes.
    await client.query(
      "UPDATE line_truck_statuses SET payload=payload||'{\"ttnStatus\":true}'::jsonb WHERE shift_id='shift_src'",
    );
    await assert.rejects(
      () => historicalizeConfirmedLegacy(client, { confirmationId: 'conf_src', confirmReportSha256: built.sha256, maintenanceActorUid: ids.adminUid }),
      { code: 'report-bytes-changed' },
    );
    assert.equal((await client.query("SELECT historicalized_at FROM shifts WHERE shift_id='shift_src'")).rows[0].historicalized_at, null);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id='shift_src'")).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_line_status_snapshots')).rows[0].n, 0);
    assert.equal((await client.query("SELECT state FROM legacy_historicalization_confirmations WHERE confirmation_id='conf_src'")).rows[0].state, 'pending');
  } finally { client.release(); await pool.end(); }
});

test('confirmation is one-time: reuse aborts untouched', { skip: !approved }, async () => {
  const ids = await prepare('one_time', [{ shiftId: 'shift_once' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_once');
    await historicalizeConfirmedLegacy(client, { confirmationId: 'conf_once', confirmReportSha256: built.sha256, maintenanceActorUid: ids.adminUid });
    await assert.rejects(
      () => historicalizeConfirmedLegacy(client, { confirmationId: 'conf_once', confirmReportSha256: built.sha256, maintenanceActorUid: ids.adminUid }),
      { code: 'confirmation-consumed' },
    );
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_cutover_historicalization_audit')).rows[0].n, 1);
  } finally { client.release(); await pool.end(); }
});

test('expired confirmation aborts untouched', { skip: !approved }, async () => {
  const ids = await prepare('expired', [{ shiftId: 'shift_exp' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_exp');
    await client.query("UPDATE legacy_historicalization_confirmations SET expires_at = now() - interval '1 second', confirmed_at = now() - interval '2 seconds' WHERE confirmation_id='conf_exp'");
    await assert.rejects(
      () => historicalizeConfirmedLegacy(client, { confirmationId: 'conf_exp', confirmReportSha256: built.sha256, maintenanceActorUid: ids.adminUid }),
      { code: 'confirmation-expired' },
    );
    assert.equal((await client.query("SELECT historicalized_at FROM shifts WHERE shift_id='shift_exp'")).rows[0].historicalized_at, null);
  } finally { client.release(); await pool.end(); }
});

test('foreign (non-admin) actor cannot record a confirmation', { skip: !approved }, async () => {
  const ids = await prepare('foreign', [{ shiftId: 'shift_foreign' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await assert.rejects(
      () => recordHistoricalizationConfirmation(client, {
        confirmationId: 'conf_foreign', reportBytes: built.bytes, reportSha256: built.sha256,
        ownerActorUid: ids.foremanUid, expiresAt: FUTURE, backupManifestSha256: MANIFEST, databaseFingerprint: FP,
      }),
      { code: 'owner-acl-denied' },
    );
  } finally { client.release(); await pool.end(); }
});

test('successful historicalization: historical state, no synthetic close, assignments released, snapshots immutable', { skip: !approved }, async () => {
  const ids = await prepare('success', [
    { shiftId: 'shift_ok' },
    { shiftId: 'shift_ok_nochild', withStatus: false },
  ]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_ok');
    const result = await historicalizeConfirmedLegacy(client, { confirmationId: 'conf_ok', confirmReportSha256: built.sha256, maintenanceActorUid: ids.adminUid });
    assert.equal(result.historicalized, 2);
    const shift = (await client.query("SELECT * FROM shifts WHERE shift_id='shift_ok'")).rows[0];
    assert.equal(shift.state, 'historical');
    assert.equal(shift.closed_at, null);
    assert.equal(shift.closed_by_uid, null);
    assert.equal(shift.historicalization_reason, 'legacy-type-unresolved-at-cutover');
    assert.equal(shift.historicalization_report_hash, built.sha256);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id='shift_ok'")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM legacy_line_status_snapshots WHERE shift_id='shift_ok'")).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_cutover_historicalization_audit')).rows[0].n, 2);
    await assert.rejects(
      () => client.query("UPDATE legacy_line_status_snapshots SET payload='{}'::jsonb"),
      { code: '23514' },
    );
    await assert.rejects(
      () => client.query("UPDATE shifts SET historicalized_by_uid=NULL WHERE shift_id='shift_ok'"),
      { code: '23514' },
    );
  } finally { client.release(); await pool.end(); }
});

test('fault injection after the snapshot step rolls the whole transaction back', { skip: !approved }, async () => {
  const ids = await prepare('fault', [{ shiftId: 'shift_fault' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_fault');
    // Make the audit insert fail after snapshot, removal and marker already ran.
    await client.query('ALTER TABLE legacy_cutover_historicalization_audit DROP CONSTRAINT legacy_cutover_historicalization_audit_reason_check');
    await client.query("ALTER TABLE legacy_cutover_historicalization_audit ADD CONSTRAINT legacy_cutover_historicalization_audit_reason_check CHECK (reason = 'never')");
    await assert.rejects(() => historicalizeConfirmedLegacy(client, { confirmationId: 'conf_fault', confirmReportSha256: built.sha256, maintenanceActorUid: ids.adminUid }));
    const shift = (await client.query("SELECT state, historicalized_at FROM shifts WHERE shift_id='shift_fault'")).rows[0];
    assert.equal(shift.state, 'historical');
    assert.equal(shift.historicalized_at, null);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id='shift_fault'")).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_line_status_snapshots')).rows[0].n, 0);
    assert.equal((await client.query("SELECT state FROM legacy_historicalization_confirmations WHERE confirmation_id='conf_fault'")).rows[0].state, 'pending');
  } finally { client.release(); await pool.end(); }
});
