import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
} from './helpers/isolated-db.mjs';
import { openRestoredArchive, submitArchiveOperationV2 } from '../src/archive-restored-v2.mjs';

// Restored archive v2 routes against a real database (design §3.4, §4.6, §4.7,
// §5.6, §6, §7).
//
// The root runs on the frozen S24 baseline and applies 025 itself, because the
// whole subject is the S25 restored-context schema. Every assertion runs as the
// app role. The contract proved here:
//
//   * GET `/restored` opens exactly one context per archive and is idempotent:
//     the second call returns the same context id and writes no second row;
//   * the explicit `revision` selects that immutable revision, and a revision
//     that is not the context base is `archive-changed`, not a silent re-read;
//   * opening and correcting never write a `shifts` row, a `line_logs` row, a
//     `line_truck_statuses` row or an `archive_overrides` row — the restored
//     context is never an active shift (§3.4);
//   * POST `/operations` is the common `runV2Command` path: one receipt in
//     `shift_operation_receipts`, one audit row, one `restored_context_receipts`
//     row, CAS on context/base revision and base bytes, replay by operation id;
//   * archive ACL only (`archive_edit`/`archive_delete`), membership is not
//     required, and a revoked right refuses the replay too;
//   * a forbidden type is a stable `archive-operation-not-allowed`, never a 500.

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try { requireIsolatedDatabase(connectionString); approved = true; } catch {}
}

const sha = value => createHash('sha256').update(value).digest('hex');
const bytesOf = value => Buffer.from(JSON.stringify(value), 'utf8');

const WS = 'workspace_archive_restore';
const FOREIGN_WS = 'workspace_archive_restore_foreign';
const ADMIN = 'admin_archive_restore';
const ARCHIVIST = 'archivist_archive_restore';
const VIEWER = 'viewer_archive_restore';
const TRUCK1 = 'truck_ar_1';
const TRUCK2 = 'truck_ar_2';
const ARCHIVE = 'archive_restore_open';
const SOURCE_SHIFT = 'shift_archive_restore_source';
const LIVE_SHIFT = 'shift_archive_restore_live';
const STARTED_AT = Date.UTC(2026, 10, 23, 5, 0, 0);
const CLOSED_AT = STARTED_AT + 8 * 3_600_000;

// Everything the restored context must leave byte-for-byte untouched. The two
// receipt/audit tables of the command runner are excluded on purpose: they are
// the command's own evidence and are asserted by count below.
const OUTSIDE_TABLES = [
  'shifts', 'line_logs', 'line_truck_statuses', 'line_trucks',
  'archive_overrides', 'tabel_records', 'game_records',
  'shift_archive_series', 'shift_archive_revisions', 'archive_revision_publications',
  'workspace_service_receipts', 'line_audit', 'line_operation_receipts',
  'line_history', 'history_audit', 'history_receipts',
];

const archivePayload = {
  sourceShiftId: SOURCE_SHIFT,
  objectId: 'site',
  objectName: 'Объект',
  date: '23.11.2026',
  openedAt: STARTED_AT,
  closedAt: CLOSED_AT,
  closedBy: 'Закрывший прораб',
  activeLineIds: [TRUCK1, TRUCK2],
  ttnStatus: { [TRUCK1]: 'pending' },
  logs: [
    { id: 'src_a', truckId: TRUCK1, truckName: 'A111AA77', timestamp: STARTED_AT + 3_600_000, volume: 24, timeStr: '10:00', comment: '', isGAI: false },
    { id: 'src_b', truckId: TRUCK1, truckName: 'A111AA77', timestamp: STARTED_AT + 5_400_000, volume: 12, timeStr: '11:30', comment: '', isGAI: false },
    { id: 'src_c', truckId: TRUCK2, truckName: 'B222BB77', timestamp: STARTED_AT + 7_200_000, volume: 8, timeStr: '12:00', comment: '', isGAI: false },
  ],
  totalTrips: 3,
  totalVolume: 44,
};

const liveShiftPayload = {
  payloadSchemaVersion: 2, id: LIVE_SHIFT, shiftId: LIVE_SHIFT,
  objectId: 'site', objectName: 'Объект',
  startDate: '23.11.2026', date: '2026-11-23',
  workShift: 'day', type: 'day', state: 'active', isActive: true,
  startedAt: STARTED_AT, startedBy: 'Живой прораб', startedByUid: ADMIN,
};

let pool;
let archiveSha = '';
let openView = null;
let revision = 1;

async function outsideDigest(client) {
  const parts = [];
  for (const table of OUTSIDE_TABLES) {
    const rows = (await client.query(
      `SELECT row_to_json(t)::text AS row FROM (SELECT * FROM ${table} WHERE workspace_id=$1) t ORDER BY 1`,
      [WS],
    )).rows;
    parts.push([table, rows.map(row => row.row)]);
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function counts(client) {
  return (await client.query(
    `SELECT (SELECT count(*)::int FROM restored_shift_contexts WHERE workspace_id=$1) contexts,
            (SELECT count(*)::int FROM restored_context_logs WHERE workspace_id=$1) logs,
            (SELECT count(*)::int FROM restored_context_status_snapshots WHERE workspace_id=$1) snapshots,
            (SELECT count(*)::int FROM restored_context_receipts WHERE workspace_id=$1) receipts,
            (SELECT count(*)::int FROM restored_context_audit WHERE workspace_id=$1) audit,
            (SELECT count(*)::int FROM shift_operation_receipts WHERE workspace_id=$1) shift_receipts,
            (SELECT count(*)::int FROM workspace_service_audit WHERE workspace_id=$1) service_audit`,
    [WS],
  )).rows[0];
}

const rejected = (promise, code, status) => assert.rejects(promise, error => {
  assert.equal(error.name, 'V2Error', `expected a V2Error, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
});

const operation = (id, type, recordId, contextRevision, extra = {}) => ({
  workspaceId: WS, archiveId: ARCHIVE, operationId: id, protocolVersion: 2,
  restoredContextId: openView.restoredContextId, type, recordId,
  expectedContextRevision: contextRevision,
  expectedBaseArchiveRevision: 1,
  expectedBaseSha256: archiveSha,
  ...extra,
});

test.before(async () => {
  if (!approved) return;
  await resetIsolatedDatabase();
  await applyMigrationsThrough(29);
  pool = new pg.Pool({ connectionString, max: 6 });
  pool.on('error', () => {});
  const client = await pool.connect();
  try {
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [WS, FOREIGN_WS]);
    for (const [uid, role, status] of [
      [ADMIN, 'admin', 'active'],
      [ARCHIVIST, 'archivist', 'active'],
      [VIEWER, 'viewer', 'active'],
    ]) {
      await client.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, uid, role, status],
      );
    }
    // Archive ACL only: correction needs `archive_edit`, deletion `archive_delete`.
    for (const action of ['archive_edit', 'archive_delete', 'tab_archive']) {
      await client.query("INSERT INTO role_permissions(role,action,allowed) VALUES('archivist',$1,true)", [action]);
    }
    for (const truck of [TRUCK1, TRUCK2]) {
      await client.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
        [WS, truck, { id: truck, brand: 'Fixture', number: truck }]);
    }
    // The source business shift is archived: the series exists, no `shifts` row.
    await client.query(
      'INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id) VALUES($1,$2,$3)',
      [WS, ARCHIVE, SOURCE_SHIFT],
    );
    const bytes = bytesOf(archivePayload);
    archiveSha = sha(bytes);
    await client.query(
      `INSERT INTO shift_archive_revisions(
         workspace_id,archive_id,archive_revision,payload_bytes,payload_sha256,
         payload_schema_version,source_kind,source_locator,created_by_uid)
       VALUES($1,$2,1,$3,$4,2,'native-close',$5,$6)`,
      [WS, ARCHIVE, bytes, archiveSha, `close:${ARCHIVE}:1`, ADMIN],
    );
    await client.query(
      'UPDATE shift_archive_series SET latest_finalized_revision=1,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
      [WS, ARCHIVE, archiveSha],
    );
    // Active object and a live line that must survive every restored-archive
    // command untouched.
    await client.query('INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
      [WS, 'site', { id: 'site', name: 'Объект' }]);
    await client.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3::jsonb)',
      [WS, LIVE_SHIFT, liveShiftPayload],
    );
    await client.query(
      'INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)',
      [WS, TRUCK1, LIVE_SHIFT, { id: TRUCK1, shiftId: LIVE_SHIFT, onLine: true, cycleRevision: 5, ttnRevision: 2 }],
    );
    await client.query(
      'INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
      [WS, 'live_log_1', LIVE_SHIFT, TRUCK1, { id: 'live_log_1', shiftId: LIVE_SHIFT, truckId: TRUCK1, volume: 24, timestamp: STARTED_AT, timeStr: '09:00', comment: '' }],
    );
  } finally {
    client.release();
  }
  openView = await openRestoredArchive(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' }, {
    workspaceId: WS, archiveId: ARCHIVE,
  });
});

test.after(async () => {
  if (pool) await pool.end();
});

test('GET restored opens one idempotent context from the latest finalized revision', { skip: !approved }, async () => {
  const client = await pool.connect();
  try {
    assert.equal(openView.protocolVersion, 2);
    assert.equal(openView.workspaceId, WS);
    assert.equal(openView.archiveId, ARCHIVE);
    assert.equal(openView.sourceShiftId, SOURCE_SHIFT);
    assert.equal(openView.archiveRevision, 1);
    assert.equal(openView.archiveSha256, archiveSha);
    assert.equal(openView.contextRevision, 1);
    assert.equal(openView.contextState, 'open');
    assert.equal(openView.mode, 'parallel', 'an active line makes this a parallel restored context');
    assert.equal(openView.restoredContextId.startsWith('rctx_'), true);
    assert.equal(openView.trips.length, 3);
    assert.deepEqual(openView.trips.map(trip => trip.logId).sort(), ['src_a', 'src_b', 'src_c']);
    assert.equal(openView.trips[0].sourceLogId, openView.trips[0].logId);
    assert.equal(openView.ttn.find(row => row.truckId === TRUCK1).ttnStatus, 'pending');
    // The archive carries no opener uid: provenance stays unresolved with the
    // explicit UI text, never a guessed author.
    assert.equal(openView.provenance.originalOpenedByUid, null);
    assert.equal(openView.provenance.originalIdentityResolution, 'unresolved');
    assert.equal(openView.provenance.unresolvedAuthor, true);
    assert.equal(openView.provenance.authorText, 'автор не установлен');
    assert.equal(openView.provenance.originalShiftType, null);
    assert.equal(openView.provenance.unresolvedShiftType, true);
    assert.equal(openView.provenance.restoredByUid, ARCHIVIST);

    // The context is not an active shift and the source identity is exact.
    const context = (await client.query(
      `SELECT archive_id,source_shift_id,mode,context_state,archive_revision,context_revision,
              object_id,object_name,to_char(work_date,'YYYY-MM-DD') AS work_date,
              original_identity_resolution,original_shift_type_resolution
         FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2`,
      [WS, openView.restoredContextId],
    )).rows[0];
    assert.equal(context.archive_id, ARCHIVE);
    assert.equal(context.source_shift_id, SOURCE_SHIFT);
    assert.equal(context.object_name, 'Объект');
    assert.equal(context.work_date, '2026-11-23');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1 AND shift_id LIKE $2', [WS, 'shift_archive_restore%'])).rows[0].n, 1, 'only the seeded live shift exists');
  } finally {
    client.release();
  }
});

test('a repeated open returns the same context and writes no second row', { skip: !approved }, async () => {
  const client = await pool.connect();
  try {
    const before = await counts(client);
    const again = await openRestoredArchive(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' }, {
      workspaceId: WS, archiveId: ARCHIVE,
    });
    assert.equal(again.restoredContextId, openView.restoredContextId);
    assert.equal(again.contextRevision, openView.contextRevision);
    assert.deepEqual(await counts(client), before);
    assert.equal(before.contexts, 1);
    assert.equal(before.logs, 3);
    assert.equal(before.snapshots, 2);

    // Explicit revision 1 is the same immutable base; a revision that does not
    // exist is a stable 404, never an invented revision.
    const explicit = await openRestoredArchive(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' }, {
      workspaceId: WS, archiveId: ARCHIVE, revision: 1,
    });
    assert.equal(explicit.restoredContextId, openView.restoredContextId);
    await rejected(openRestoredArchive(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' }, {
      workspaceId: WS, archiveId: ARCHIVE, revision: 2,
    }), 'archive-not-found', 404);
    await rejected(openRestoredArchive(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' }, {
      workspaceId: WS, archiveId: 'archive_absent',
    }), 'archive-not-found', 404);
    // Another workspace does not see this archive at all.
    await rejected(openRestoredArchive(pool, { uid: ADMIN, displayName: 'Админ', role: 'admin' }, {
      workspaceId: FOREIGN_WS, archiveId: ARCHIVE,
    }), 'archive-not-found', 404);
  } finally {
    client.release();
  }
});

test('opening needs the archive right and never an active membership', { skip: !approved }, async () => {
  const client = await pool.connect();
  try {
    const before = await counts(client);
    const digestBefore = await outsideDigest(client);
    // A viewer has no archive right at all.
    await rejected(openRestoredArchive(pool, { uid: VIEWER, displayName: 'Смотрящий', role: 'viewer' }, {
      workspaceId: WS, archiveId: ARCHIVE,
    }), 'forbidden', 403);
    // An inactive user is refused before anything else.
    await client.query("UPDATE app_users SET status='disabled' WHERE uid=$1", [VIEWER]);
    try {
      await rejected(openRestoredArchive(pool, { uid: VIEWER, displayName: 'Смотрящий', role: 'viewer' }, {
        workspaceId: WS, archiveId: ARCHIVE,
      }), 'forbidden', 403);
    } finally {
      await client.query("UPDATE app_users SET status='active' WHERE uid=$1", [VIEWER]);
    }
    assert.deepEqual(await counts(client), before);
    assert.equal(await outsideDigest(client), digestBefore);
    // Admin passes by role without a membership row.
    assert.equal((await client.query('SELECT count(*)::int AS n FROM shift_members WHERE workspace_id=$1', [WS])).rows[0].n, 0);
    const asAdmin = await openRestoredArchive(pool, { uid: ADMIN, displayName: 'Админ', role: 'admin' }, {
      workspaceId: WS, archiveId: ARCHIVE,
    });
    assert.equal(asAdmin.restoredContextId, openView.restoredContextId);
  } finally {
    client.release();
  }
});

test('POST operations corrects the context through the common v2 command runner', { skip: !approved }, async () => {
  const client = await pool.connect();
  try {
    const digestBefore = await outsideDigest(client);
    const before = await counts(client);

    const update = await submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      operation('op_ar_trip_update', 'trip.update', 'src_a', revision, {
        volume: 18, timeStr: '09:30', comment: 'правка архива',
      }));
    assert.equal(update.protocolVersion, 2);
    assert.equal(update.operationId, 'op_ar_trip_update');
    assert.equal(update.replayed, false);
    assert.equal(update.result.contextRevision, revision + 1);
    assert.equal(update.result.type, 'trip.update');
    assert.equal(update.result.recordId, 'src_a');
    assert.equal(update.result.log.volume, 18);
    assert.equal(update.result.log.timeStr, '09:30');
    revision += 1;

    // Both receipt layers exist exactly once: the common runner's shift-scoped
    // receipt/audit and the restored-context domain receipt/audit.
    const after = await counts(client);
    assert.equal(after.shift_receipts, before.shift_receipts + 1);
    assert.equal(after.service_audit, before.service_audit + 1);
    assert.equal(after.receipts, before.receipts + 1);
    assert.equal(after.audit, before.audit + 1);
    assert.equal(after.logs, before.logs);
    const shiftReceipt = (await client.query(
      "SELECT operation_id,shift_id,result FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id='op_ar_trip_update'",
      [WS],
    )).rows[0];
    assert.equal(shiftReceipt.shift_id, SOURCE_SHIFT, 'the receipt is attributed to the archived source shift');
    assert.equal(shiftReceipt.result.contextRevision, revision);
    const domainReceipt = (await client.query(
      "SELECT restored_context_id,protocol_version,result FROM restored_context_receipts WHERE workspace_id=$1 AND operation_id='op_ar_trip_update'",
      [WS],
    )).rows[0];
    assert.equal(domainReceipt.restored_context_id, openView.restoredContextId);
    assert.equal(domainReceipt.protocol_version, 2);
    assert.equal(domainReceipt.result.result.contextRevision, revision);

    // The live line and the immutable archive chain are untouched.
    assert.equal(await outsideDigest(client), digestBefore);
    assert.equal((await client.query('SELECT payload FROM line_logs WHERE workspace_id=$1 AND log_id=$2', [WS, 'live_log_1'])).rows[0].payload.volume, 24);
    assert.equal((await client.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2 AND shift_id=$3', [WS, TRUCK1, LIVE_SHIFT])).rows[0].payload.cycleRevision, 5);
    assert.equal((await client.query('SELECT payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1', [WS, ARCHIVE])).rows[0].payload_sha256, archiveSha);

    // TTN correction: the immutable source snapshot stays, the journal carries it.
    const ttn = await submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      operation('op_ar_ttn_update', 'ttn.update', TRUCK2, revision, { ttnStatus: true }));
    assert.equal(ttn.result.contextRevision, revision + 1);
    assert.deepEqual(ttn.result.ttn, { truckId: TRUCK2, ttnStatus: true });
    revision += 1;
    assert.equal((await client.query(
      'SELECT payload FROM restored_context_status_snapshots WHERE workspace_id=$1 AND restored_context_id=$2 AND truck_id=$3',
      [WS, openView.restoredContextId, TRUCK1],
    )).rows[0].payload.ttnStatus, 'pending', 'the source snapshot is never rewritten');

    // A trip delete is `archive_delete`, not `archive_edit`.
    const deleted = await submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      operation('op_ar_trip_delete', 'trip.delete', 'src_b', revision));
    assert.equal(deleted.result.contextRevision, revision + 1);
    assert.equal(deleted.result.log, null);
    revision += 1;
    assert.equal(await outsideDigest(client), digestBefore);

    // The corrected context is what a re-read returns.
    const reread = await openRestoredArchive(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' }, {
      workspaceId: WS, archiveId: ARCHIVE,
    });
    assert.equal(reread.contextRevision, revision);
    assert.equal(reread.trips.length, 2);
    assert.equal(reread.trips.find(trip => trip.logId === 'src_a').payload.volume, 18);
  } finally {
    client.release();
  }
});

test('a replay returns the same result and a changed body is operation-id-reused', { skip: !approved }, async () => {
  const client = await pool.connect();
  try {
    const command = operation('op_ar_replay', 'trip.update', 'src_c', revision, {
      volume: 9, timeStr: '12:30', comment: 'повтор',
    });
    const first = await submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' }, command);
    assert.equal(first.replayed, false);
    assert.equal(first.result.contextRevision, revision + 1);
    revision += 1;
    const afterFirst = await counts(client);

    const replay = await submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' }, command);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.deepEqual(await counts(client), afterFirst);
    assert.equal((await client.query(
      'SELECT context_revision::text AS r FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2',
      [WS, openView.restoredContextId],
    )).rows[0].r, String(revision));

    // The same operation id with a different body is a conflict, not a replay.
    await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      { ...command, volume: 10 }), 'operation-id-reused', 409);
    assert.deepEqual(await counts(client), afterFirst);

    // A revoked right refuses the replay too: authorization precedes the receipt.
    await client.query("UPDATE role_permissions SET allowed=false WHERE role='archivist' AND action='archive_edit'");
    try {
      await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' }, command), 'forbidden', 403);
    } finally {
      await client.query("UPDATE role_permissions SET allowed=true WHERE role='archivist' AND action='archive_edit'");
    }
    assert.deepEqual(await counts(client), afterFirst);
  } finally {
    client.release();
  }
});

test('CAS on context, base revision and base bytes refuses a stale command', { skip: !approved }, async () => {
  const client = await pool.connect();
  try {
    const before = await counts(client);
    const digestBefore = await outsideDigest(client);
    const data = { volume: 11, timeStr: '10:15', comment: 'cas' };

    await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      operation('op_ar_cas_context', 'trip.update', 'src_a', revision - 1, data)), 'archive-changed', 409);
    await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      operation('op_ar_cas_revision', 'trip.update', 'src_a', revision, { ...data, expectedBaseArchiveRevision: 2 })), 'archive-changed', 409);
    await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      operation('op_ar_cas_sha', 'trip.update', 'src_a', revision, { ...data, expectedBaseSha256: sha('другие байты') })), 'archive-changed', 409);
    // An unknown record and an unknown context are stable 404s.
    await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      operation('op_ar_missing_trip', 'trip.update', 'log_absent', revision, data)), 'restored-trip-not-found', 404);
    await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      operation('op_ar_missing_context', 'trip.update', 'src_a', revision, { ...data, restoredContextId: 'rctx_absent' })), 'archive-context-not-found', 404);
    // A context of another archive cannot be addressed through this path.
    await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
      operation('op_ar_wrong_archive', 'trip.update', 'src_a', revision, { ...data, archiveId: 'archive_other' })), 'archive-changed', 409);

    assert.deepEqual(await counts(client), before);
    assert.equal(await outsideDigest(client), digestBefore);
    assert.equal((await client.query(
      'SELECT context_revision::text AS r FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2',
      [WS, openView.restoredContextId],
    )).rows[0].r, String(revision));
  } finally {
    client.release();
  }
});

test('a forbidden type writes nothing, and a finalized context refuses corrections', { skip: !approved }, async () => {
  const client = await pool.connect();
  try {
    const before = await counts(client);
    const digestBefore = await outsideDigest(client);
    for (const type of ['restored.finalize', 'archive.restore', 'shift.close']) {
      await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
        operation(`op_ar_type_${type.replace(/\W/g, '_')}`, type, 'src_a', revision)), 'archive-operation-not-allowed', 400);
    }
    assert.deepEqual(await counts(client), before);
    assert.equal(await outsideDigest(client), digestBefore);

    // Finalize is owned by another route; here it only means "no more edits".
    await client.query(
      "UPDATE restored_shift_contexts SET context_state='finalized' WHERE workspace_id=$1 AND restored_context_id=$2",
      [WS, openView.restoredContextId],
    );
    try {
      await rejected(submitArchiveOperationV2(pool, { uid: ARCHIVIST, displayName: 'Архивист', role: 'archivist' },
        operation('op_ar_finalized', 'trip.delete', 'src_a', revision)), 'archive-context-finalized', 409);
      assert.equal((await client.query(
        'SELECT count(*)::int AS n FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2',
        [WS, openView.restoredContextId],
      )).rows[0].n, 2);
    } finally {
      await client.query(
        "UPDATE restored_shift_contexts SET context_state='open' WHERE workspace_id=$1 AND restored_context_id=$2",
        [WS, openView.restoredContextId],
      );
    }
  } finally {
    client.release();
  }
});
