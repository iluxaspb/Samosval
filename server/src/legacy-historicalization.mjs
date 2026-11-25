import { createHash } from 'node:crypto';

// Explicit, versioned unfinished-cycle predicate (design §3.3, brief D10).
// Task 5 (remove/close) MUST import these exports instead of duplicating the rule.
export const UNFINISHED_CYCLE_RULE_ID = 'unfinished-cycle-v1';

export function isUnfinishedCycle(status) {
  if (!status || typeof status !== 'object' || status.onLine !== true) return false;
  const hasArrive = Number.isFinite(status.arriveTimestamp) && status.arriveTimestamp > 0;
  const hasLoad = Number.isFinite(status.lastLoadTimestamp) && status.lastLoadTimestamp > 0;
  if (!hasArrive && !hasLoad) return false;
  return status.ttnStatus !== true;
}

export const REPORT_SCHEMA = 'samosval.legacy-historicalization/v1';
export const REDACTION_POLICY = 'samosval.legacy-redaction/v1-no-truck-ids';
export const HISTORICALIZATION_REASON = 'legacy-type-unresolved-at-cutover';
export const CONSEQUENCES = Object.freeze([
  'Текущие назначения этих самосвалов будут освобождены',
  'Незавершённая работа будет сохранена как неизменяемый исторический снимок и не будет считаться завершённой',
]);
const CLOSE_KEYS = ['closedAt', 'closedBy', 'closedByUid', 'closing', 'closingStartedAt', 'closingBy', 'closingByUid'];

const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const sha256Hex = value => createHash('sha256').update(value).digest('hex');

// Byte order, never locale/collation order: the report must hash identically on a
// database with a different locale after a restore into another cluster.
const byteCompare = (a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'));

// Deterministic identity of the live database. Two hard requirements:
//
// 1. ROLE INDEPENDENT. The preflight runs under the deployment/bootstrap account,
//    the destructive cutover under the maintenance executor. If any part of the hash
//    depended on `current_user` privileges (e.g. `system_identifier` from the
//    superuser-only `pg_control_system()`), the two would disagree and a legitimate
//    cutover would fail with `confirmation-environment-changed`. Everything below is
//    readable by any role, so no privilege probing and no NULL branches.
// 2. SESSION INDEPENDENT. `timestamptz::text` is rendered in the session `TimeZone`
//    (and honours `DateStyle`), so the same cluster would hash differently from a
//    connection with a different timezone. The postmaster start time is rendered
//    explicitly in UTC with a fixed format instead.
//
// It must NOT depend on data volume, otherwise recording the confirmation row itself
// would invalidate the fingerprint.
//
// `postmasterStartUtc` is intentionally part of the fingerprint: a cluster restart or
// failover between confirmation and cutover changes it and the cutover is refused
// (fail-closed). The owner then takes a fresh preflight and reconfirms. That is the
// safe direction: a stale confirmation must never survive into a different instance.
export async function computeDatabaseFingerprint(client) {
  const row = (await client.query(`
    SELECT current_database() AS database,
           (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
           to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS postmaster_start_utc
  `)).rows[0];
  return sha256Hex(canonicalJson({
    schema: 'samosval.database-fingerprint/v2',
    database: row.database,
    databaseOid: row.database_oid,
    postmasterStartUtc: row.postmaster_start_utc,
  }));
}

// RFC 8785 (JCS) for the value domain used here: sorted keys (UTF-16 code units),
// no whitespace, ECMAScript number/string serialization.
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('canonical-non-finite-number', 500);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw fail('canonical-unsupported-value', 500);
}

const scopeSql = `
  SELECT shift_id, object_id, to_char(work_date,'YYYY-MM-DD') AS work_date, state, payload, revision,
         (payload ? 'restoredFrom' OR COALESCE(payload->>'restored','')='true') AS restored_snapshot
    FROM shifts
   WHERE workspace_id=$1
     AND state='historical'
     AND payload_schema_version=1
     AND (identity_resolution='unresolved' OR shift_type_resolution='unresolved')
     AND historicalized_at IS NULL
   ORDER BY shift_id`;

function statusFieldCounts(statuses) {
  const counts = {
    onLineTrue: 0, arriveTimestampPresent: 0, lastLoadTimestampPresent: 0,
    loadedAfterArriveTrue: 0, ttnStatusPending: 0, ttnStatusCollected: 0,
  };
  for (const { payload: p } of statuses) {
    if (p.onLine === true) counts.onLineTrue++;
    if (typeof p.arriveTimestamp === 'number' && p.arriveTimestamp > 0) counts.arriveTimestampPresent++;
    if (typeof p.lastLoadTimestamp === 'number' && p.lastLoadTimestamp > 0) counts.lastLoadTimestampPresent++;
    if (p.loadedAfterArrive === true) counts.loadedAfterArriveTrue++;
    if (p.ttnStatus === 'pending') counts.ttnStatusPending++;
    if (p.ttnStatus === true) counts.ttnStatusCollected++;
  }
  return counts;
}

export async function buildHistoricalizationReport(client, context) {
  const { workspaceId, migrationVersion, generatedAt, expiresAt, backupManifestSha256, databaseFingerprint } = context;
  const shifts = (await client.query(scopeSql, [workspaceId])).rows;
  const rows = [];
  for (const shift of shifts) {
    const logs = (await client.query(
      'SELECT log_id, payload FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"',
      [workspaceId, shift.shift_id],
    )).rows;
    const statuses = (await client.query(
      'SELECT truck_id, payload, status_revision, cycle_revision, ttn_revision FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2 ORDER BY truck_id COLLATE "C"',
      [workspaceId, shift.shift_id],
    )).rows;
    const closeFields = {};
    for (const key of CLOSE_KEYS) if (Object.hasOwn(shift.payload, key)) closeFields[key] = shift.payload[key];
    const unfinishedCycleCount = statuses.filter(s => isUnfinishedCycle(s.payload)).length;
    rows.push({
      shiftId: shift.shift_id,
      objectId: shift.object_id,
      workDate: shift.work_date,
      currentState: shift.state,
      restoredSnapshot: shift.restored_snapshot === true,
      sourcePayloadSha256: sha256Hex(canonicalJson(shift.payload)),
      childCounts: { lineLogs: logs.length, truckStatuses: statuses.length },
      childrenSha256: sha256Hex(canonicalJson({
        lineLogs: logs.map(l => ({ logId: l.log_id, payload: l.payload })),
        truckStatuses: statuses.map(s => ({ truckId: s.truck_id, payload: s.payload })),
      })),
      assignmentKeysSha256: sha256Hex(canonicalJson(statuses.map(s => s.truck_id))),
      originalClosingFields: {
        presence: Object.fromEntries(CLOSE_KEYS.map(k => [k, Object.hasOwn(shift.payload, k)])),
        sha256: sha256Hex(canonicalJson(closeFields)),
      },
      assignmentSummary: {
        currentAssignmentCount: statuses.length,
        currentStatusFieldCounts: statusFieldCounts(statuses.map(s => ({ payload: s.payload }))),
        unfinishedCycleCount,
        statusSnapshotsToCreate: statuses.length,
      },
    });
  }
  rows.sort((a, b) => byteCompare(a.shiftId, b.shiftId));
  const report = {
    schema: REPORT_SCHEMA,
    workspaceId,
    migrationVersion,
    generatedAt,
    expiresAt,
    backupManifestSha256,
    databaseFingerprint,
    redactionPolicy: REDACTION_POLICY,
    unfinishedCycleRule: UNFINISHED_CYCLE_RULE_ID,
    consequences: [...CONSEQUENCES],
    rows,
  };
  const bytes = Buffer.from(canonicalJson(report), 'utf8');
  return { bytes, sha256: sha256Hex(bytes), rowCount: rows.length, report };
}

export async function recordHistoricalizationConfirmation(client, input) {
  const { reportBytes, reportSha256, ownerActorUid, expiresAt, backupManifestSha256, databaseFingerprint, confirmationId } = input;
  if (typeof confirmationId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(confirmationId)) throw fail('confirmation-id-invalid', 400);
  if (!Buffer.isBuffer(reportBytes)) throw fail('report-bytes-required', 400);
  if (sha256Hex(reportBytes) !== reportSha256) throw fail('report-hash-mismatch', 400);
  const parsed = JSON.parse(reportBytes.toString('utf8'));
  if (Buffer.from(canonicalJson(parsed), 'utf8').equals(reportBytes) === false) throw fail('report-not-canonical', 400);
  if (parsed.schema !== REPORT_SCHEMA) throw fail('report-schema-mismatch', 400);
  if (parsed.backupManifestSha256 !== backupManifestSha256 || parsed.databaseFingerprint !== databaseFingerprint) {
    throw fail('report-context-mismatch', 400);
  }
  // A confirmation that is already expired (or that outlives its own report window)
  // must be rejected at write time, not silently stored and burned at consume time.
  const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  const generated = typeof parsed.generatedAt === 'string' ? Date.parse(parsed.generatedAt) : Number.NaN;
  if (!Number.isFinite(expiry) || !Number.isFinite(generated)) throw fail('expires-at-invalid', 400);
  if (parsed.expiresAt !== expiresAt) throw fail('expires-at-invalid', 400);
  if (expiry <= Date.now() || expiry <= generated) throw fail('expires-at-invalid', 400);
  const owner = (await client.query(
    "SELECT 1 FROM app_users WHERE uid=$1 AND role='admin' AND status='active'",
    [ownerActorUid],
  )).rows[0];
  if (!owner) throw fail('owner-acl-denied', 403);
  await client.query(
    `INSERT INTO legacy_historicalization_confirmations
       (confirmation_id, workspace_id, report_schema, report_sha256, report_bytes, row_count,
        owner_actor_uid, expires_at, backup_manifest_sha256, database_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [confirmationId, parsed.workspaceId, REPORT_SCHEMA, reportSha256, reportBytes, parsed.rows.length,
      ownerActorUid, expiresAt, backupManifestSha256, databaseFingerprint],
  );
  return { confirmationId, rowCount: parsed.rows.length };
}

// NOTE (Task 5 / role split): the design's "maintenance role" does not exist in the
// current model. Until the role split lands, the maintenance gate is an active
// `role='admin'` account, exactly like the owner gate. Task 5 must replace this with
// the real maintenance role and must NOT look for a role that is not there yet.
export async function historicalizeConfirmedLegacy(client, {
  confirmationId, confirmReportSha256, maintenanceActorUid, liveBackupManifestSha256,
}) {
  // The backup manifest is an external artifact (a file on the backup host), so it can
  // only come from the caller. The database fingerprint is NOT: it is recomputed from
  // this very connection below, so copying it out of report.json cannot confirm itself.
  if (typeof liveBackupManifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(liveBackupManifestSha256)) {
    throw fail('live-environment-required', 400);
  }
  await client.query('BEGIN');
  try {
    const conf = (await client.query(
      'SELECT * FROM legacy_historicalization_confirmations WHERE confirmation_id=$1 FOR UPDATE',
      [confirmationId],
    )).rows[0];
    if (!conf) throw fail('confirmation-not-found', 404);
    if (conf.state !== 'pending') throw fail('confirmation-consumed');
    if (conf.report_sha256 !== confirmReportSha256) throw fail('report-hash-mismatch');
    if (!(await client.query('SELECT expires_at > now() AS live FROM legacy_historicalization_confirmations WHERE confirmation_id=$1', [confirmationId])).rows[0].live) {
      throw fail('confirmation-expired');
    }
    const actor = (await client.query(
      "SELECT 1 FROM app_users WHERE uid=$1 AND role='admin' AND status='active'",
      [maintenanceActorUid],
    )).rows[0];
    if (!actor) throw fail('owner-acl-denied', 403);

    const stored = JSON.parse(conf.report_bytes.toString('utf8'));
    const { workspaceId } = stored;
    // The confirmation row and the exact bytes must describe the same workspace.
    if (conf.workspace_id !== workspaceId) throw fail('report-context-mismatch');
    // §4.8 п.6: the environment the owner confirmed must still be the live one.
    // The fingerprint is measured here, inside the transaction, before any mutation.
    const liveDatabaseFingerprint = await computeDatabaseFingerprint(client);
    if (stored.backupManifestSha256 !== liveBackupManifestSha256
        || stored.databaseFingerprint !== liveDatabaseFingerprint) {
      throw fail('confirmation-environment-changed');
    }
    // Lock the sources first, then rebuild from locked rows and compare bytes.
    const locked = (await client.query(
      `${scopeSql.replace('ORDER BY shift_id', 'ORDER BY shift_id COLLATE "C" FOR UPDATE')}`,
      [workspaceId],
    )).rows;
    await client.query(
      'SELECT truck_id FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id = ANY($2::text[]) ORDER BY truck_id COLLATE "C" FOR UPDATE',
      [workspaceId, locked.map(r => r.shift_id)],
    );
    await client.query(
      'SELECT log_id FROM line_logs WHERE workspace_id=$1 AND shift_id = ANY($2::text[]) ORDER BY log_id COLLATE "C" FOR SHARE',
      [workspaceId, locked.map(r => r.shift_id)],
    );
    const rebuilt = await buildHistoricalizationReport(client, {
      workspaceId,
      migrationVersion: stored.migrationVersion,
      generatedAt: stored.generatedAt,
      expiresAt: stored.expiresAt,
      backupManifestSha256: stored.backupManifestSha256,
      databaseFingerprint: stored.databaseFingerprint,
    });
    if (!rebuilt.bytes.equals(conf.report_bytes)) throw fail('report-bytes-changed');

    const consumed = await client.query(
      "UPDATE legacy_historicalization_confirmations SET state='consumed', consumed_at=now(), consumed_by_uid=$2 WHERE confirmation_id=$1 AND state='pending'",
      [confirmationId, maintenanceActorUid],
    );
    if (consumed.rowCount !== 1) throw fail('confirmation-consumed');

    for (const row of rebuilt.report.rows) {
      const statuses = (await client.query(
        'SELECT truck_id, payload, status_revision, cycle_revision, ttn_revision FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2 ORDER BY truck_id COLLATE "C"',
        [workspaceId, row.shiftId],
      )).rows;
      for (const s of statuses) {
        // The canonical text is stored next to the payload so the DB itself can prove
        // the hash belongs to this payload (see the snapshot CHECKs in 025).
        const canonical = canonicalJson(s.payload);
        await client.query(
          `INSERT INTO legacy_line_status_snapshots
             (workspace_id, confirmation_id, shift_id, truck_id, payload, payload_canonical, payload_sha256,
              status_revision, cycle_revision, ttn_revision)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [workspaceId, confirmationId, row.shiftId, s.truck_id, s.payload, canonical, sha256Hex(canonical),
            s.status_revision, s.cycle_revision, s.ttn_revision],
        );
      }
      if (statuses.length !== row.assignmentSummary.statusSnapshotsToCreate) throw fail('snapshot-count-mismatch', 500);
      const removed = await client.query(
        'DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2',
        [workspaceId, row.shiftId],
      );
      if (removed.rowCount !== statuses.length) throw fail('status-removal-mismatch', 500);

      const shiftRow = locked.find(r => r.shift_id === row.shiftId);
      const updated = await client.query(
        `UPDATE shifts SET historicalized_at=now(), historicalized_by_uid=$3,
                historicalization_reason=$4, historicalization_report_hash=$5, revision=revision+1
          WHERE workspace_id=$1 AND shift_id=$2 AND state='historical' AND historicalized_at IS NULL
         RETURNING revision`,
        [workspaceId, row.shiftId, maintenanceActorUid, HISTORICALIZATION_REASON, rebuilt.sha256],
      );
      if (updated.rowCount !== 1) throw fail('shift-changed');

      const closeFields = {};
      for (const key of CLOSE_KEYS) if (Object.hasOwn(shiftRow.payload, key)) closeFields[key] = shiftRow.payload[key];
      await client.query(
        `INSERT INTO legacy_cutover_historicalization_audit
           (workspace_id, confirmation_id, report_schema, report_sha256, shift_id, source_payload_sha256,
            children_sha256, restored_snapshot, old_state, new_state, reason, original_close_fields,
            maintenance_actor_uid, result_revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'historical','historical',$9,$10,$11,$12)`,
        [workspaceId, confirmationId, REPORT_SCHEMA, rebuilt.sha256, row.shiftId, row.sourcePayloadSha256,
          row.childrenSha256, row.restoredSnapshot === true, HISTORICALIZATION_REASON, closeFields,
          maintenanceActorUid, updated.rows[0].revision],
      );
    }
    await client.query('COMMIT');
    return { confirmationId, historicalized: rebuilt.rowCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
