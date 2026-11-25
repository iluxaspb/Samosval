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
  computeDatabaseFingerprint,
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

// Unresolved-type legacy row -> 025 classifies it as historical (report scope).
async function seedLegacyV1(pool, ids, { shiftId, withStatus = true, logs = [], foreign = false, restored = false, restoredOpener = false }) {
  const payload = foreign
    ? {
      id: shiftId, objectId: ids.objectAId, objectName: ids.objectAId,
      startDate: '23.11.2026', startedAt: 1795420800000, startedBy: ids.adminUid,
      startedByUid: ids.adminUid, isActive: false, workShift: 'day',
      closedAt: 1795420900000, closedByUid: ids.adminUid,
    }
    : {
      id: shiftId, objectId: ids.objectAId, objectName: ids.objectAId,
      startDate: '23.11.2026', startedAt: 1795420800000, startedBy: 'legacy', isActive: false,
      // M2: an archived copy may carry the original creator uid in its payload. It
      // is the document's own value, never proof produced by the restoration.
      ...(restoredOpener ? { startedByUid: ids.adminUid } : {}),
      closing: true, closingStartedAt: 1795420900000, closingBy: 'legacy', state: 'closing',
      // D7: a restored archive copy is never a live line and never a proven opener.
      ...(restored ? { restored: true, restoredFrom: `${shiftId}_archive` } : {}),
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
  for (const [index, log] of logs.entries()) {
    await pool.query(
      'INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
      [ids.workspaceId, log.logId ?? `${shiftId}_log_${index}`, shiftId, `${shiftId}_truck`, log],
    );
  }
}

async function buildFor(client, ids, overrides = {}) {
  return buildHistoricalizationReport(client, {
    workspaceId: ids.workspaceId,
    migrationVersion: '025_parallel_shifts_core.sql',
    generatedAt: '2026-11-25T00:00:00.000Z',
    expiresAt: overrides.expiresAt ?? FUTURE,
    backupManifestSha256: overrides.backupManifestSha256 ?? MANIFEST,
    databaseFingerprint: overrides.databaseFingerprint ?? await computeDatabaseFingerprint(client),
  });
}

function confirm(client, ids, built, confirmationId, overrides = {}) {
  return recordHistoricalizationConfirmation(client, {
    confirmationId,
    reportBytes: built.bytes,
    reportSha256: built.sha256,
    ownerActorUid: overrides.ownerActorUid ?? ids.adminUid,
    expiresAt: overrides.expiresAt ?? FUTURE,
    // The override is how a test supplies a malformed hash (M4); the default stays
    // exactly the value the report carries.
    backupManifestSha256: overrides.backupManifestSha256 ?? built.report.backupManifestSha256,
    databaseFingerprint: built.report.databaseFingerprint,
  });
}

// The backup manifest is the only caller-supplied "live" value; the database
// fingerprint is measured by the module itself, so it cannot be faked from here.
function consume(client, ids, built, confirmationId, overrides = {}) {
  return historicalizeConfirmedLegacy(client, {
    confirmationId,
    confirmReportSha256: overrides.confirmReportSha256 ?? built.sha256,
    maintenanceActorUid: overrides.maintenanceActorUid ?? ids.adminUid,
    liveBackupManifestSha256: overrides.liveBackup ?? built.report.backupManifestSha256,
  });
}

// Replaces the fingerprint inside the stored confirmation bytes and recomputes the
// hash, so the row is internally consistent but describes a different cluster.
async function rewriteStoredFingerprint(client, confirmationId, fingerprint) {
  const stored = JSON.parse((await client.query(
    'SELECT report_bytes FROM legacy_historicalization_confirmations WHERE confirmation_id=$1',
    [confirmationId],
  )).rows[0].report_bytes.toString('utf8'));
  stored.databaseFingerprint = fingerprint;
  const bytes = Buffer.from(canonicalJson(stored), 'utf8');
  await client.query(
    "UPDATE legacy_historicalization_confirmations SET report_bytes=$2, report_sha256=encode(sha256($2),'hex') WHERE confirmation_id=$1",
    [confirmationId, bytes],
  );
  return bytes;
}

async function counts(client) {
  const row = (await client.query(`
    SELECT (SELECT count(*) FROM legacy_line_status_snapshots)::int AS snapshots,
           (SELECT count(*) FROM legacy_cutover_historicalization_audit)::int AS audit,
           (SELECT count(*) FROM line_truck_statuses)::int AS statuses,
           (SELECT count(*) FROM line_logs)::int AS logs
  `)).rows[0];
  return row;
}

async function assertUntouched(client, { statuses, logs = 0 }) {
  assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_line_status_snapshots')).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_cutover_historicalization_audit')).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM line_truck_statuses')).rows[0].n, statuses);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM line_logs')).rows[0].n, logs);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM shifts WHERE historicalized_at IS NOT NULL')).rows[0].n, 0);
  const confirmations = (await client.query('SELECT state FROM legacy_historicalization_confirmations')).rows;
  assert.ok(confirmations.every(row => row.state === 'pending'), 'every confirmation stays pending');
}

test('report is exact, schema-tagged, sorted and free of close values or PII', { skip: !approved }, async () => {
  const ids = await prepare('report_exact', [
    { shiftId: 'shift_z_report' },
    { shiftId: 'shift_a_report', withStatus: false },
  ]);
  const pool = db();
  const client = await pool.connect();
  try {
    // Fixed fingerprint keeps this golden hash independent of the cluster identity.
    const a = await buildFor(client, ids, { databaseFingerprint: FP });
    const b = await buildFor(client, ids, { databaseFingerprint: FP });
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
    assert.deepEqual(a.report.consequences, [
      'Текущие назначения этих самосвалов будут освобождены',
      'Незавершённая работа будет сохранена как неизменяемый исторический снимок и не будет считаться завершённой',
    ]);
    assert.equal(Object.hasOwn(a.report.rows[0].assignmentSummary, 'safeTruckIds'), false);
    // Byte-exactness: any changed key order, count or consequence text changes this hash.
    assert.equal(a.sha256, '6ea9e539863b804def35c5d1b710f26a36230ed4a1f3a53b689d29c5d4c7630f');
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
    await assert.rejects(() => consume(client, ids, built, 'conf_byte'), { code: 'report-hash-mismatch' });
    await assertUntouched(client, { statuses: 1 });
  } finally { client.release(); await pool.end(); }
});

// Stored bytes are the compared artifact: mutating the consequence text or the
// redaction policy inside them must be detected by the byte-for-byte rebuild.
for (const [label, from, to] of [
  ['consequences', 'будут освобождены', 'будут освобожденЫ'],
  ['redaction-policy', 'samosval.legacy-redaction/v1-no-truck-ids', 'samosval.legacy-redaction/v1-no-truck-idz'],
]) {
  test(`stored bytes mutated at ${label} abort byte-for-byte with no mutation`, { skip: !approved }, async () => {
    const ids = await prepare(`bytes_${label}`, [{ shiftId: 'shift_bm' }]);
    const pool = db();
    const client = await pool.connect();
    try {
      const built = await buildFor(client, ids);
      await confirm(client, ids, built, 'conf_bm');
      const text = built.bytes.toString('utf8');
      assert.ok(text.includes(from), `fixture must contain ${label}`);
      const mutated = Buffer.from(text.replace(from, to), 'utf8');
      assert.equal(mutated.length, built.bytes.length, 'same-length mutation keeps the row shape');
      await client.query(
        "UPDATE legacy_historicalization_confirmations SET report_bytes=$2, report_sha256=encode(sha256($2),'hex') WHERE confirmation_id=$1",
        ['conf_bm', mutated],
      );
      await assert.rejects(
        () => consume(client, ids, built, 'conf_bm', { confirmReportSha256: sha(mutated) }),
        { code: 'report-bytes-changed' },
      );
      await assertUntouched(client, { statuses: 1 });
    } finally { client.release(); await pool.end(); }
  });
}

// ---------- Major 1: the live environment must match the confirmation ----------

test('a confirmation that describes another database aborts before any mutation', { skip: !approved }, async () => {
  const ids = await prepare('env_fp', [{ shiftId: 'shift_env_fp' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_env_fp');
    // The stored confirmation now describes a different cluster, with a valid hash of
    // its own bytes. Nothing the caller can pass makes it match the live fingerprint.
    const bytes = await rewriteStoredFingerprint(client, 'conf_env_fp', sha('another-cluster'));
    await assert.rejects(
      () => consume(client, ids, built, 'conf_env_fp', { confirmReportSha256: sha(bytes) }),
      { code: 'confirmation-environment-changed' },
    );
    await assertUntouched(client, { statuses: 1 });
  } finally { client.release(); await pool.end(); }
});

test('a different live backup manifest aborts before any mutation', { skip: !approved }, async () => {
  const ids = await prepare('env_backup', [{ shiftId: 'shift_env_bk' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_env_bk');
    await assert.rejects(
      () => consume(client, ids, built, 'conf_env_bk', { liveBackup: sha('another-backup') }),
      { code: 'confirmation-environment-changed' },
    );
    await assertUntouched(client, { statuses: 1 });
  } finally { client.release(); await pool.end(); }
});

test('a malformed backup manifest hash is refused at confirmation time', { skip: !approved }, async () => {
  const ids = await prepare('env_manifest_format', [{ shiftId: 'shift_env_mf' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    // M4: the writer enforces the same `^[0-9a-f]{64}$` as the CLI. A typo must be
    // caught here, not on the destructive step where the report cannot be consumed.
    for (const malformed of ['not-a-sha256', MANIFEST.toUpperCase(), `${MANIFEST}0`, MANIFEST.slice(0, 63)]) {
      await assert.rejects(
        () => confirm(client, ids, built, 'conf_env_mf', { backupManifestSha256: malformed }),
        { code: 'backup-manifest-sha256-invalid', status: 400 },
      );
    }
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_historicalization_confirmations')).rows[0].n, 0,
      'a refused confirmation is never stored');
  } finally { client.release(); await pool.end(); }
});

test('a migration applied after the confirmation aborts before any mutation', { skip: !approved }, async () => {
  const ids = await prepare('env_migration', [{ shiftId: 'shift_env_mig' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_env_mig');
    // M1: the report carries `migrationVersion`; it must be the live registry value,
    // not a copy of the stored one. A next migration between confirmation and
    // cutover is exactly the drift this catches.
    await client.query("INSERT INTO schema_migrations(filename) VALUES('026_future_migration.sql')");
    await assert.rejects(() => consume(client, ids, built, 'conf_env_mig'), { code: 'confirmation-environment-changed' });
    await assertUntouched(client, { statuses: 1 });
  } finally { client.release(); await pool.end(); }
});

test('a missing or malformed live backup manifest is refused, never self-confirmed', { skip: !approved }, async () => {
  const ids = await prepare('env_missing', [{ shiftId: 'shift_env_ms' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_env_ms');
    await assert.rejects(() => consume(client, ids, built, 'conf_env_ms', { liveBackup: '' }), { code: 'live-environment-required' });
    await assert.rejects(() => consume(client, ids, built, 'conf_env_ms', { liveBackup: 'not-a-hash' }), { code: 'live-environment-required' });
    await assertUntouched(client, { statuses: 1 });
  } finally { client.release(); await pool.end(); }
});

test('matching live environment completes the cutover', { skip: !approved }, async () => {
  const ids = await prepare('env_ok', [{ shiftId: 'shift_env_ok' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    assert.match(built.report.databaseFingerprint, /^[0-9a-f]{64}$/, 'fingerprint is a real cluster identity');
    assert.equal(built.report.databaseFingerprint, await computeDatabaseFingerprint(client));
    await confirm(client, ids, built, 'conf_env_ok');
    const result = await consume(client, ids, built, 'conf_env_ok');
    assert.equal(result.historicalized, 1);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id='shift_env_ok'")).rows[0].n, 0);
  } finally { client.release(); await pool.end(); }
});

test('computeDatabaseFingerprint is deterministic and independent of data volume', { skip: !approved }, async () => {
  const ids = await prepare('env_det', [{ shiftId: 'shift_env_det' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const first = await computeDatabaseFingerprint(client);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(await computeDatabaseFingerprint(client), first);
    // Recording a confirmation (a write) must not change the fingerprint.
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_env_det');
    assert.equal(await computeDatabaseFingerprint(client), first);
  } finally { client.release(); await pool.end(); }
});

test('the fingerprint does not depend on the session TimeZone or DateStyle', { skip: !approved }, async () => {
  const ids = await prepare('env_tz', [{ shiftId: 'shift_env_tz' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const baseline = await computeDatabaseFingerprint(client);
    await client.query("SET TIME ZONE 'Asia/Tokyo'");
    await client.query("SET DateStyle = 'SQL, DMY'");
    try {
      assert.equal(await computeDatabaseFingerprint(client), baseline, 'timezone must not change the fingerprint');
    } finally {
      await client.query("SET TIME ZONE 'UTC'");
      await client.query("SET DateStyle = 'ISO, MDY'");
    }
    assert.equal(await computeDatabaseFingerprint(client), baseline);
  } finally { client.release(); await pool.end(); }
});

test('the fingerprint does not depend on the privileges of the executing role', { skip: !approved }, async () => {
  const ids = await prepare('env_role', [{ shiftId: 'shift_env_role' }]);
  const pool = db();
  const client = await pool.connect();
  const probe = 'samosval_fingerprint_probe';
  let revoked = false;
  // M3: the original ACL is captured and restored exactly. A blanket GRANT would
  // add a privilege PUBLIC may never have had and would hide a later regression.
  const originalAcl = (await client.query(
    "SELECT proacl::text AS acl FROM pg_proc WHERE oid='pg_control_system()'::regprocedure",
  )).rows[0].acl;
  try {
    const baseline = await computeDatabaseFingerprint(client);
    // A throwaway NOLOGIN role with no grants stands in for the maintenance executor.
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${probe}') THEN CREATE ROLE ${probe} NOLOGIN; END IF; END $$`);
    const asProbe = async () => {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL ROLE ${probe}`);
        const allowed = (await client.query(
          "SELECT has_function_privilege(current_user,'pg_control_system()','EXECUTE') AS ok",
        )).rows[0].ok;
        const fingerprint = await computeDatabaseFingerprint(client);
        return { allowed, fingerprint };
      } finally {
        await client.query('ROLLBACK');
      }
    };

    const plain = await asProbe();
    assert.equal(plain.fingerprint, baseline, 'a different role must not change the fingerprint');

    // The exact asymmetry the v1 fingerprint suffered from: revoke EXECUTE on the
    // superuser-flavoured function and measure again under the same role. v1 branched
    // on this privilege and produced a different hash; v2 does not read it at all.
    await client.query('REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC');
    revoked = true;
    const withoutControl = await asProbe();
    assert.equal(withoutControl.allowed, false, 'the probe must really lose EXECUTE for this check to mean anything');
    assert.equal(withoutControl.fingerprint, baseline, 'losing pg_control_system() must not change the fingerprint');

    assert.equal(await computeDatabaseFingerprint(client), baseline);
  } finally {
    if (revoked) {
      await (originalAcl === null
        ? client.query("UPDATE pg_proc SET proacl=NULL WHERE oid='pg_control_system()'::regprocedure")
        : client.query("UPDATE pg_proc SET proacl=$1::aclitem[] WHERE oid='pg_control_system()'::regprocedure", [originalAcl])
      ).catch(() => {});
      const restoredAcl = (await client.query(
        "SELECT proacl::text AS acl FROM pg_proc WHERE oid='pg_control_system()'::regprocedure",
      )).rows[0].acl;
      assert.equal(restoredAcl, originalAcl, 'the original ACL must be restored exactly');
    }
    await client.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${probe}') THEN DROP ROLE ${probe}; END IF; END $$`).catch(() => {});
    client.release();
    await pool.end();
  }
});

// ---------- Major 2: full mutation matrix ----------

const mutations = [
  {
    name: 'an added assignment',
    statusesAfter: 2,
    mutate: async (client, ids, shiftId) => {
      const truckId = `${shiftId}_extra_truck`;
      await client.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
        [ids.workspaceId, truckId, { id: truckId }]);
      await client.query('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)',
        [ids.workspaceId, truckId, shiftId, { id: truckId, shiftId, onLine: true }]);
    },
  },
  {
    name: 'a removed assignment',
    statusesAfter: 0,
    mutate: (client, ids, shiftId) => client.query('DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2', [ids.workspaceId, shiftId]),
  },
  {
    name: 'onLine true->false',
    statusesAfter: 1,
    mutate: (client, ids, shiftId) => client.query(
      "UPDATE line_truck_statuses SET payload = payload || '{\"onLine\": false}'::jsonb WHERE workspace_id=$1 AND shift_id=$2",
      [ids.workspaceId, shiftId]),
  },
  {
    name: 'arriveTimestamp presence',
    statusesAfter: 1,
    mutate: (client, ids, shiftId) => client.query(
      "UPDATE line_truck_statuses SET payload = payload - 'arriveTimestamp' WHERE workspace_id=$1 AND shift_id=$2",
      [ids.workspaceId, shiftId]),
  },
  {
    name: 'lastLoadTimestamp presence',
    statusesAfter: 1,
    mutate: (client, ids, shiftId) => client.query(
      "UPDATE line_truck_statuses SET payload = payload || '{\"lastLoadTimestamp\": 1795420800001}'::jsonb WHERE workspace_id=$1 AND shift_id=$2",
      [ids.workspaceId, shiftId]),
  },
  {
    name: 'loadedAfterArrive',
    statusesAfter: 1,
    mutate: (client, ids, shiftId) => client.query(
      "UPDATE line_truck_statuses SET payload = payload || '{\"loadedAfterArrive\": true}'::jsonb WHERE workspace_id=$1 AND shift_id=$2",
      [ids.workspaceId, shiftId]),
  },
  {
    name: 'unfinished -> finished cycle',
    statusesAfter: 1,
    mutate: (client, ids, shiftId) => client.query(
      "UPDATE line_truck_statuses SET payload = payload || '{\"ttnStatus\": true}'::jsonb WHERE workspace_id=$1 AND shift_id=$2",
      [ids.workspaceId, shiftId]),
  },
];

for (const { name, statusesAfter, mutate } of mutations) {
  test(`source mutation: ${name} -> report-bytes-changed, zero mutation`, { skip: !approved }, async () => {
    const suffix = `mut_${name.replaceAll(/[^a-z0-9]/gi, '_').toLowerCase()}`;
    const shiftId = `shift_${suffix}`;
    const ids = await prepare(suffix, [{ shiftId }]);
    const pool = db();
    const client = await pool.connect();
    try {
      const built = await buildFor(client, ids);
      await confirm(client, ids, built, `conf_${suffix}`);
      await mutate(client, ids, shiftId);
      // snapshot-count / assignment-count changed for add/remove; every case must abort.
      await assert.rejects(() => consume(client, ids, built, `conf_${suffix}`), { code: 'report-bytes-changed' });
      await assertUntouched(client, { statuses: statusesAfter });
    } finally { client.release(); await pool.end(); }
  });
}

// ---------- Major 3: children (logs) and shift granularity ----------

test('logs are counted, hashed, preserved and recorded in audit', { skip: !approved }, async () => {
  const ids = await prepare('logs', [{
    shiftId: 'shift_logs',
    logs: [
      { id: 'shift_logs_log_0', shiftId: 'shift_logs', truckId: 'shift_logs_truck', volume: 12, timestamp: 1795420800000 },
      { id: 'shift_logs_log_1', shiftId: 'shift_logs', truckId: 'shift_logs_truck', volume: 7, timestamp: 1795420900000 },
    ],
  }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    const row = built.report.rows.find(r => r.shiftId === 'shift_logs');
    assert.equal(row.childCounts.lineLogs, 2, 'logs must be part of childCounts');
    assert.equal(row.childCounts.truckStatuses, 1);
    const logsBefore = (await client.query("SELECT log_id, payload FROM line_logs WHERE shift_id='shift_logs' ORDER BY log_id COLLATE \"C\"")).rows;
    await confirm(client, ids, built, 'conf_logs');
    await consume(client, ids, built, 'conf_logs');
    const logsAfter = (await client.query("SELECT log_id, payload FROM line_logs WHERE shift_id='shift_logs' ORDER BY log_id COLLATE \"C\"")).rows;
    assert.deepEqual(logsAfter, logsBefore, 'logs are never deleted or rewritten');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id='shift_logs'")).rows[0].n, 0);
    const audit = (await client.query("SELECT children_sha256, source_payload_sha256, restored_snapshot FROM legacy_cutover_historicalization_audit WHERE shift_id='shift_logs'")).rows[0];
    assert.equal(audit.children_sha256, row.childrenSha256, 'audit keeps the per-child hash from the report');
    assert.equal(audit.source_payload_sha256, row.sourcePayloadSha256);
    assert.equal(audit.restored_snapshot, false);
  } finally { client.release(); await pool.end(); }
});

test('a log change after confirmation aborts byte-for-byte with no mutation', { skip: !approved }, async () => {
  const ids = await prepare('logs_mut', [{
    shiftId: 'shift_logs_mut',
    logs: [{ id: 'shift_logs_mut_log_0', shiftId: 'shift_logs_mut', truckId: 'shift_logs_mut_truck', volume: 5, timestamp: 1795420800000 }],
  }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_logs_mut');
    await client.query("UPDATE line_logs SET payload = payload || '{\"volume\": 9}'::jsonb WHERE log_id='shift_logs_mut_log_0'");
    await assert.rejects(() => consume(client, ids, built, 'conf_logs_mut'), { code: 'report-bytes-changed' });
    await assertUntouched(client, { statuses: 1, logs: 1 });
  } finally { client.release(); await pool.end(); }
});

test('a foreign shift keeps its own statuses and logs untouched', { skip: !approved }, async () => {
  const ids = await prepare('foreign_shift', [
    { shiftId: 'shift_target', logs: [{ id: 'shift_target_log_0', shiftId: 'shift_target', truckId: 'shift_target_truck', volume: 3, timestamp: 1795420800000 }] },
    { shiftId: 'shift_foreign_keep', foreign: true, logs: [{ id: 'shift_foreign_log_0', shiftId: 'shift_foreign_keep', truckId: 'shift_foreign_keep_truck', volume: 4, timestamp: 1795420800000 }] },
  ]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    assert.deepEqual(built.report.rows.map(r => r.shiftId), ['shift_target'], 'only the unresolved row is in scope');
    const foreignBefore = (await client.query("SELECT state, closed_at FROM shifts WHERE shift_id='shift_foreign_keep'")).rows[0];
    assert.equal(foreignBefore.state, 'closed');
    await confirm(client, ids, built, 'conf_foreign_shift');
    await consume(client, ids, built, 'conf_foreign_shift');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id='shift_target'")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id='shift_foreign_keep'")).rows[0].n, 1, 'foreign statuses survive');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_logs WHERE shift_id='shift_foreign_keep'")).rows[0].n, 1, 'foreign logs survive');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_logs WHERE shift_id='shift_target'")).rows[0].n, 1, 'target logs survive');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM legacy_line_status_snapshots WHERE shift_id='shift_foreign_keep'")).rows[0].n, 0);
    const foreignAfter = (await client.query("SELECT state, closed_at FROM shifts WHERE shift_id='shift_foreign_keep'")).rows[0];
    assert.deepEqual(foreignAfter, foreignBefore, 'the foreign shift is not touched');
  } finally { client.release(); await pool.end(); }
});

// ---------- confirmation guards ----------

test('confirmation is one-time: reuse aborts untouched', { skip: !approved }, async () => {
  const ids = await prepare('one_time', [{ shiftId: 'shift_once' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_once');
    await consume(client, ids, built, 'conf_once');
    await assert.rejects(() => consume(client, ids, built, 'conf_once'), { code: 'confirmation-consumed' });
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
    await assert.rejects(() => consume(client, ids, built, 'conf_exp'), { code: 'confirmation-expired' });
    assert.equal((await client.query("SELECT historicalized_at FROM shifts WHERE shift_id='shift_exp'")).rows[0].historicalized_at, null);
  } finally { client.release(); await pool.end(); }
});

test('an unknown confirmation aborts', { skip: !approved }, async () => {
  const ids = await prepare('missing_conf', [{ shiftId: 'shift_miss' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await assert.rejects(() => consume(client, ids, built, 'conf_does_not_exist'), { code: 'confirmation-not-found' });
    await assertUntouched(client, { statuses: 1 });
  } finally { client.release(); await pool.end(); }
});

test('foreign (non-admin) actor cannot record or consume a confirmation', { skip: !approved }, async () => {
  const ids = await prepare('foreign_actor', [{ shiftId: 'shift_foreign_actor' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await assert.rejects(
      () => confirm(client, ids, built, 'conf_foreign_actor', { ownerActorUid: ids.foremanUid }),
      { code: 'owner-acl-denied' },
    );
    await confirm(client, ids, built, 'conf_foreign_actor');
    await assert.rejects(
      () => consume(client, ids, built, 'conf_foreign_actor', { maintenanceActorUid: ids.foremanUid }),
      { code: 'owner-acl-denied' },
    );
    await assertUntouched(client, { statuses: 1 });
  } finally { client.release(); await pool.end(); }
});

test('an already expired or inconsistent expiresAt is refused at write time', { skip: !approved }, async () => {
  const ids = await prepare('expiry_write', [{ shiftId: 'shift_expw' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await assert.rejects(
      () => confirm(client, ids, built, 'conf_expw', { expiresAt: '2020-01-01T00:00:00.000Z' }),
      { code: 'expires-at-invalid' },
    );
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_historicalization_confirmations')).rows[0].n, 0);
    await assertUntouched(client, { statuses: 1 });
  } finally { client.release(); await pool.end(); }
});

test('report bytes that are not canonical, wrong schema or wrong context are refused', { skip: !approved }, async () => {
  const ids = await prepare('bad_report', [{ shiftId: 'shift_bad' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    const pretty = Buffer.from(JSON.stringify(built.report, null, 2), 'utf8');
    await assert.rejects(
      () => recordHistoricalizationConfirmation(client, {
        confirmationId: 'conf_pretty', reportBytes: pretty, reportSha256: sha(pretty),
        ownerActorUid: ids.adminUid, expiresAt: FUTURE,
        backupManifestSha256: MANIFEST, databaseFingerprint: built.report.databaseFingerprint,
      }),
      { code: 'report-not-canonical' },
    );
    const wrongSchema = JSON.parse(built.bytes.toString('utf8'));
    wrongSchema.schema = 'samosval.legacy-historicalization/v0';
    const wrongSchemaBytes = Buffer.from(canonicalJson(wrongSchema), 'utf8');
    await assert.rejects(
      () => recordHistoricalizationConfirmation(client, {
        confirmationId: 'conf_schema', reportBytes: wrongSchemaBytes, reportSha256: sha(wrongSchemaBytes),
        ownerActorUid: ids.adminUid, expiresAt: FUTURE,
        backupManifestSha256: MANIFEST, databaseFingerprint: built.report.databaseFingerprint,
      }),
      { code: 'report-schema-mismatch' },
    );
    await assert.rejects(
      () => recordHistoricalizationConfirmation(client, {
        confirmationId: 'conf_ctx', reportBytes: built.bytes, reportSha256: built.sha256,
        ownerActorUid: ids.adminUid, expiresAt: FUTURE,
        backupManifestSha256: sha('other-manifest'), databaseFingerprint: built.report.databaseFingerprint,
      }),
      { code: 'report-context-mismatch' },
    );
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_historicalization_confirmations')).rows[0].n, 0);
  } finally { client.release(); await pool.end(); }
});

// ---------- successful cutover and rollback ----------

test('successful historicalization: historical state, no synthetic close, assignments released, snapshots immutable', { skip: !approved }, async () => {
  const ids = await prepare('success', [
    { shiftId: 'shift_ok', logs: [{ id: 'shift_ok_log_0', shiftId: 'shift_ok', truckId: 'shift_ok_truck', volume: 6, timestamp: 1795420800000 }] },
    { shiftId: 'shift_ok_nochild', withStatus: false },
  ]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_ok');
    const result = await consume(client, ids, built, 'conf_ok');
    assert.equal(result.historicalized, 2);
    const shift = (await client.query("SELECT * FROM shifts WHERE shift_id='shift_ok'")).rows[0];
    assert.equal(shift.state, 'historical');
    assert.equal(shift.closed_at, null);
    assert.equal(shift.closed_by_uid, null);
    assert.equal(shift.closing_started_at, null);
    assert.equal(shift.closing_by_uid, null);
    assert.equal(shift.is_active, false);
    assert.notEqual(shift.historicalized_at, null);
    assert.equal(shift.historicalized_by_uid, ids.adminUid);
    assert.equal(shift.historicalization_reason, 'legacy-type-unresolved-at-cutover');
    assert.equal(shift.historicalization_report_hash, built.sha256);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id='shift_ok'")).rows[0].n, 0);
    // Exactly one snapshot per current assignment of the shift, as the report promised.
    const okRow = built.report.rows.find(r => r.shiftId === 'shift_ok');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM legacy_line_status_snapshots WHERE shift_id='shift_ok'")).rows[0].n,
      okRow.assignmentSummary.statusSnapshotsToCreate);
    const snapshot = (await client.query("SELECT payload, payload_canonical, payload_sha256 FROM legacy_line_status_snapshots WHERE shift_id='shift_ok'")).rows[0];
    assert.equal(snapshot.payload_sha256, sha(snapshot.payload_canonical), 'hash is bound to the stored canonical bytes');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_cutover_historicalization_audit')).rows[0].n, 2);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_logs WHERE shift_id='shift_ok'")).rows[0].n, 1);
    await assert.rejects(() => client.query("UPDATE legacy_line_status_snapshots SET payload='{}'::jsonb"), { code: '23514' });
    await assert.rejects(() => client.query('TRUNCATE legacy_line_status_snapshots'), { code: '23514' });
    await assert.rejects(() => client.query('TRUNCATE legacy_cutover_historicalization_audit'), { code: '23514' });
    await assert.rejects(() => client.query("UPDATE shifts SET historicalized_by_uid=NULL WHERE shift_id='shift_ok'"), { code: '23514' });
  } finally { client.release(); await pool.end(); }
});

test('a restored legacy row is audited as a restored snapshot, never as a proven opener', { skip: !approved }, async () => {
  const ids = await prepare('restored', [{ shiftId: 'shift_restored', restored: true, restoredOpener: true }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    const row = built.report.rows.find(r => r.shiftId === 'shift_restored');
    assert.equal(row.restoredSnapshot, true, 'the report marks the restored copy');
    // M2: the copy carries the original creator uid in its own payload, yet the
    // report must not present it as a proven author — it emits no identity at all.
    assert.equal(built.bytes.toString('utf8').includes(ids.adminUid), false, 'no uid in the report');
    assert.equal(Object.hasOwn(row, 'openedByUid'), false);
    await confirm(client, ids, built, 'conf_restored');
    await consume(client, ids, built, 'conf_restored');
    const audit = (await client.query(
      "SELECT restored_snapshot, old_state, new_state FROM legacy_cutover_historicalization_audit WHERE shift_id='shift_restored'",
    )).rows[0];
    assert.equal(audit.restored_snapshot, true, 'audit keeps the restored flag');
    assert.equal(audit.old_state, 'historical');
    assert.equal(audit.new_state, 'historical');
    const shift = (await client.query(
      "SELECT state, opened_by_uid, identity_resolution, closed_at, closed_by_uid FROM shifts WHERE shift_id='shift_restored'",
    )).rows[0];
    assert.equal(shift.state, 'historical');
    // The uid stays exactly as the archived document stated it (source), and the
    // restoration never invents a close actor or a proven close.
    assert.equal(shift.opened_by_uid, ids.adminUid);
    assert.equal(shift.identity_resolution, 'source');
    assert.equal(shift.closed_at, null);
    assert.equal(shift.closed_by_uid, null);
  } finally { client.release(); await pool.end(); }
});

test('a confirmation row bound to another workspace aborts before any mutation', { skip: !approved }, async () => {
  const ids = await prepare('workspace_mismatch', [{ shiftId: 'shift_ws' }]);
  const pool = db();
  const client = await pool.connect();
  try {
    const built = await buildFor(client, ids);
    await confirm(client, ids, built, 'conf_ws');
    const otherWorkspace = `${ids.workspaceId}_other`;
    await client.query('INSERT INTO workspaces(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [otherWorkspace]);
    await client.query('UPDATE legacy_historicalization_confirmations SET workspace_id=$2 WHERE confirmation_id=$1', ['conf_ws', otherWorkspace]);
    await assert.rejects(() => consume(client, ids, built, 'conf_ws'), { code: 'report-context-mismatch' });
    await assertUntouched(client, { statuses: 1 });
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
    await assert.rejects(() => consume(client, ids, built, 'conf_fault'));
    const shift = (await client.query("SELECT state, historicalized_at FROM shifts WHERE shift_id='shift_fault'")).rows[0];
    assert.equal(shift.state, 'historical');
    assert.equal(shift.historicalized_at, null);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM line_truck_statuses WHERE shift_id='shift_fault'")).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM legacy_line_status_snapshots')).rows[0].n, 0);
    assert.equal((await client.query("SELECT state FROM legacy_historicalization_confirmations WHERE confirmation_id='conf_fault'")).rows[0].state, 'pending');
  } finally { client.release(); await pool.end(); }
});
